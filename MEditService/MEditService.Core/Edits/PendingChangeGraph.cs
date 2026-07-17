using System.Text.Json;
using DuckDB.NET.Data;

namespace MEditService.Core.Edits;

/// <summary>
/// The single home of change-group policy (ADR-0028). A change group is a connected component of
/// the pending-change dependency graph: <c>pending_changes</c> supplies the nodes and the three
/// edge rules below supply the edges. Nothing here reads <c>pending_changes.group_id</c> — that
/// column is still written by the staging paths, but it is no longer the grouping.
/// <para>
/// A new kind of dependency between changes is a new edge rule here, not a new place that assigns
/// a group at staging time. That inversion is the point: six staging paths each computing a
/// <c>group_id</c> is what produced #112, where <c>StageEdit</c> assigned null and made ordinary
/// field edits invisible and unsavable.
/// </para>
/// </summary>
internal static class PendingChangeGraph
{
    /// <summary>
    /// Partitions <paramref name="nodes"/> into connected components. Order within a component
    /// follows <paramref name="nodes"/>; components are ordered by their first member.
    /// </summary>
    internal static List<List<PendingChange>> Components(DuckDBConnection conn, IReadOnlyList<PendingChange> nodes)
    {
        var uf = new UnionFind(nodes.Count);
        if (nodes.Count > 1)
        {
            var index = BuildNodeIndex(nodes);
            var pendingRefs = LoadPendingRefs(conn);
            ApplyCreatedRecordRule(nodes, uf);
            ApplyLifecycleReferenceRule(conn, nodes, index, pendingRefs, uf);
            ApplyAddedMasterRule(nodes, pendingRefs, uf);
        }

        var byRoot = new Dictionary<int, List<PendingChange>>();
        for (var i = 0; i < nodes.Count; i++)
        {
            if (!byRoot.TryGetValue(uf.Find(i), out var members))
                byRoot[uf.Find(i)] = members = [];
            members.Add(nodes[i]);
        }
        return [.. byRoot.Values];
    }

    // --- Edge rule 2: B edits a record that A creates -------------------------------------------
    // Same (form_key, plugin) as a pending $create. A record that does not exist on disk yet cannot
    // have its field edits saved or reverted apart from the create that brings it into being.
    private static void ApplyCreatedRecordRule(IReadOnlyList<PendingChange> nodes, UnionFind uf)
    {
        var createByRecord = new Dictionary<(string, string), int>(RecordKeyComparer);
        for (var i = 0; i < nodes.Count; i++)
        {
            if (nodes[i].ChangeType == PendingChangeConstants.CreateChangeType)
                createByRecord[(nodes[i].FormKey, nodes[i].Plugin)] = i;
        }
        if (createByRecord.Count == 0) return;

        for (var i = 0; i < nodes.Count; i++)
        {
            if (createByRecord.TryGetValue((nodes[i].FormKey, nodes[i].Plugin), out var createIndex))
                uf.Union(i, createIndex);
        }
    }

    // --- Edge rule 1: B references a FormKey that A brings into or out of existence --------------
    // A is a $create, $delete or $renumber on FormKey T and B holds a reference to T. "Holds a
    // reference" spans both edge sources, and the committed half is not optional: a delete
    // nullification *removes* B's pending reference to T and a renumber cascade *repoints* it to
    // T's successor, so for those two the pending edge is exactly what the change destroys and only
    // the committed reference still records the entanglement. Only ref-to-pending-create — where T
    // has no committed existence — is carried by pending_form_references.
    private static void ApplyLifecycleReferenceRule(
        DuckDBConnection conn,
        IReadOnlyList<PendingChange> nodes,
        Dictionary<(string, string, string), int> index,
        List<PendingRefRow> pendingRefs,
        UnionFind uf)
    {
        var lifecycleByTarget = LifecycleNodesByTarget(nodes);
        if (lifecycleByTarget.Count == 0) return;

        void UnionReference(PendingRefRow r)
        {
            if (lifecycleByTarget.TryGetValue(r.TargetFormKey, out var lifecycleNodes) &&
                index.TryGetValue((r.SourceFormKey, r.SourcePlugin, r.StagedField), out var b))
            {
                foreach (var a in lifecycleNodes)
                    uf.Union(a, b);
            }
        }

        foreach (var r in pendingRefs) UnionReference(r);
        foreach (var r in LoadCommittedRefsToLifecycleTargets(conn)) UnionReference(r);
    }

    // Every lifecycle change indexed by the FormKey a reference to it would name: the FormKey it
    // acts on, plus — for a renumber — the successor FormKey, which is what cascading reference
    // updates now point at. A multimap, not a Dictionary<string,int>: a renumber successor can
    // collide with another record's lifecycle FormKey, and one-node-per-FormKey would let the second
    // write overwrite the first and drop an edge — under-grouping, which splits an atomic set and
    // lets half be saved without the rest. A reference to a colliding FormKey unions against every
    // lifecycle change on it.
    private static Dictionary<string, List<int>> LifecycleNodesByTarget(IReadOnlyList<PendingChange> nodes)
    {
        var byTarget = new Dictionary<string, List<int>>(StringComparer.OrdinalIgnoreCase);
        void Add(string formKey, int node)
        {
            if (!byTarget.TryGetValue(formKey, out var list))
                byTarget[formKey] = list = [];
            list.Add(node);
        }
        for (var i = 0; i < nodes.Count; i++)
        {
            if (!PendingChangeConstants.IsLifecycle(nodes[i].ChangeType)) continue;
            Add(nodes[i].FormKey, i);
            if (nodes[i].ChangeType == PendingChangeConstants.RenumberChangeType &&
                nodes[i].NewValue.ValueKind == JsonValueKind.String &&
                nodes[i].NewValue.GetString() is { } successor)
            {
                Add(successor, i);
            }
        }
        return byTarget;
    }

    // --- Edge rule 3: B references a record reachable only via a master that A adds --------------
    // A plugin-level dependency rather than a FormKey-level one: A appends masters to a plugin's
    // header, and B is a change in that plugin that only resolves because of them. Mirrors what
    // EditOrchestrator.StageMissingMasters computes when it decides a master is missing — the
    // record's own origin plugin, plus the origin of everything it references.
    private static void ApplyAddedMasterRule(
        IReadOnlyList<PendingChange> nodes,
        List<PendingRefRow> pendingRefs,
        UnionFind uf)
    {
        var refsBySource = pendingRefs.ToLookup(r => (r.SourceFormKey, r.SourcePlugin), RecordKeyComparer);

        for (var a = 0; a < nodes.Count; a++)
        {
            if (AddedMasters(nodes[a]) is not { } added) continue;

            for (var b = 0; b < nodes.Count; b++)
            {
                if (a != b && ReachesAddedMaster(nodes[b], nodes[a].Plugin, added, refsBySource))
                    uf.Union(a, b);
            }
        }
    }

    /// <summary>The masters a header change appends, or null when it is not an add-masters change.</summary>
    private static HashSet<string>? AddedMasters(PendingChange change)
    {
        if (change.RecordType != Records.HeaderIndexer.TableName ||
            change.FieldPath != Records.HeaderIndexer.MastersFieldName)
        {
            return null;
        }

        var added = MasterList(change.NewValue);
        added.ExceptWith(MasterList(change.OldValue));
        return added.Count == 0 ? null : added;
    }

    private static bool ReachesAddedMaster(
        PendingChange b,
        string headerPlugin,
        HashSet<string> added,
        ILookup<(string, string), PendingRefRow> refsBySource)
    {
        if (!b.Plugin.Equals(headerPlugin, StringComparison.OrdinalIgnoreCase)) return false;

        // The record's own origin covers a copy-to of a record whose home plugin is the new master,
        // even when the record holds no FormLinks at all; the refs cover everything it points at.
        return (OriginPluginOf(b.FormKey) is { } origin && added.Contains(origin)) ||
               refsBySource[(b.FormKey, b.Plugin)]
                   .Any(r => OriginPluginOf(r.TargetFormKey) is { } o && added.Contains(o));
    }

    private static HashSet<string> MasterList(JsonElement masters) =>
        masters.ValueKind != JsonValueKind.Array
            ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            : new HashSet<string>(
                masters.EnumerateArray().Where(m => m.ValueKind == JsonValueKind.String).Select(m => m.GetString()!),
                StringComparer.OrdinalIgnoreCase);

    /// <summary>The plugin substring of a "FormID:Plugin" FormKey string; null when malformed.</summary>
    private static string? OriginPluginOf(string formKey)
    {
        var colon = formKey.IndexOf(':');
        return colon >= 0 && colon < formKey.Length - 1 ? formKey[(colon + 1)..] : null;
    }

    private sealed record PendingRefRow(string SourceFormKey, string SourcePlugin, string StagedField, string TargetFormKey);

    private static List<PendingRefRow> LoadPendingRefs(DuckDBConnection conn)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT source_form_key, source_plugin, staged_field, target_form_key
            FROM pending_form_references
            """;
        return ReadRefRows(cmd);
    }

    // The committed reference index, narrowed by join to records with a pending delete or renumber —
    // the index spans the whole load order, but only a reference *to* a record being deleted or
    // renumbered can form an edge here. Joining on pending_changes does that filtering in the
    // database and keeps this query static.
    //
    // Create is deliberately absent: a freshly-reserved create FormKey has no committed existence,
    // so nothing in form_references can reference it and the join would yield zero rows. That is the
    // edge-source split the ADR-0028 amendment on this branch spells out — ref-to-pending-create is
    // carried by pending_form_references alone, delete-nullification and renumber-cascade by the
    // committed index because staging them is precisely what removes or repoints the pending edge.
    //
    // Only the lifecycle change's own FormKey is joined, not a renumber's successor: the successor
    // is a FormKey that does not exist on disk yet, so the committed index cannot reference it.
    // Successor edges are pending-side only, and handled by the pending_form_references pass.
    //
    // field_path here is a full path ("Items[3].Item") while the staged change that nullifies or
    // rewrites it is keyed on the top-level field ("Items"), so match on that prefix — exactly what
    // AddNullificationMembers and the renumber cascade key their members on.
    private static List<PendingRefRow> LoadCommittedRefsToLifecycleTargets(DuckDBConnection conn)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            SELECT DISTINCT
                fr.source_form_key,
                fr.source_plugin,
                regexp_extract(fr.field_path, '^[^.\[]*'),
                fr.target_form_key
            FROM form_references fr
            JOIN pending_changes pc ON fr.target_form_key = pc.form_key
            WHERE pc.change_type IN (
                '{PendingChangeConstants.DeleteChangeType}',
                '{PendingChangeConstants.RenumberChangeType}')
            """;
        return ReadRefRows(cmd);
    }

    private static List<PendingRefRow> ReadRefRows(DuckDBCommand cmd)
    {
        var rows = new List<PendingRefRow>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            rows.Add(new PendingRefRow(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3)));
        return rows;
    }

    private static Dictionary<(string, string, string), int> BuildNodeIndex(IReadOnlyList<PendingChange> nodes)
    {
        var index = new Dictionary<(string, string, string), int>(FieldKeyComparer);
        for (var i = 0; i < nodes.Count; i++)
            index[(nodes[i].FormKey, nodes[i].Plugin, nodes[i].FieldPath)] = i;
        return index;
    }

    private static readonly IEqualityComparer<(string, string)> RecordKeyComparer =
        new TupleOrdinalIgnoreCaseComparer();

    private static readonly IEqualityComparer<(string, string, string)> FieldKeyComparer =
        new TripleOrdinalIgnoreCaseComparer();

    private sealed class TupleOrdinalIgnoreCaseComparer : IEqualityComparer<(string, string)>
    {
        public bool Equals((string, string) x, (string, string) y) =>
            StringComparer.OrdinalIgnoreCase.Equals(x.Item1, y.Item1) &&
            StringComparer.OrdinalIgnoreCase.Equals(x.Item2, y.Item2);

        public int GetHashCode((string, string) obj) => HashCode.Combine(
            StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item1),
            StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item2));
    }

    private sealed class TripleOrdinalIgnoreCaseComparer : IEqualityComparer<(string, string, string)>
    {
        public bool Equals((string, string, string) x, (string, string, string) y) =>
            StringComparer.OrdinalIgnoreCase.Equals(x.Item1, y.Item1) &&
            StringComparer.OrdinalIgnoreCase.Equals(x.Item2, y.Item2) &&
            StringComparer.OrdinalIgnoreCase.Equals(x.Item3, y.Item3);

        public int GetHashCode((string, string, string) obj) => HashCode.Combine(
            StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item1),
            StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item2),
            StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item3));
    }

    private sealed class UnionFind(int size)
    {
        private readonly int[] _parent = [.. Enumerable.Range(0, size)];

        internal int Find(int x)
        {
            while (_parent[x] != x)
                x = _parent[x] = _parent[_parent[x]];
            return x;
        }

        internal void Union(int a, int b)
        {
            var (ra, rb) = (Find(a), Find(b));
            if (ra != rb) _parent[Math.Max(ra, rb)] = Math.Min(ra, rb);
        }
    }
}
