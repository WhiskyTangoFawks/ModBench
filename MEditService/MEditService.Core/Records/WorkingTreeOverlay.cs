using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>The working-tree overlay collaborator of <see cref="DuckDbRecordIndex"/>, which owns
/// every transaction and the winner sweep. Uses <c>PluginIngest</c>'s collectors so an edit's
/// derived rows cannot drift from ingest's.</summary>
internal sealed class WorkingTreeOverlay
{
    private const string HeadRelation = "records_head";

    // The columns `records` and `records_committed` share, in declaration order. Every read, copy
    // and insert here names it, so no column is silently dropped from a row.
    internal const string RecordColumnList =
        "form_key, plugin, origin, record_type, editor_id, \"ref\", body, content_hash, parse_diagnosis";

    private readonly DuckDBConnection _connection;
    private readonly ILogger _logger;
    private readonly RecordTextCodec _codec;
    private readonly PlacementWalker _placementWalker;
    private readonly GameRelease _release;
    private readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas;

    public WorkingTreeOverlay(
        DuckDBConnection connection, ILogger logger, RecordTextCodec codec, PlacementWalker placementWalker,
        GameRelease release, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        _connection = connection;
        _logger = logger;
        _codec = codec;
        _placementWalker = placementWalker;
        _release = release;
        _schemas = schemas;
    }

    /// <summary>See <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>. Returns whether any delta
    /// added or removed an Effective row; the caller resweeps winners on that answer.</summary>
    public bool ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        var structural = false;
        foreach (var (formKey, body) in deltas)
            structural |= ApplyOneWorkingTreeChange(key, formKey, body);
        return structural;
    }

    // Returns true when it added or removed an Effective row — a structural change, the only kind
    // that can move winner status.
    private bool ApplyOneWorkingTreeChange(PluginKey key, string formKey, string? body)
    {
        // The committed bytes, wherever they currently live: the snapshot if this record already
        // diverged, else the still-clean Effective row itself. Reading through the Head relation is
        // what makes those two cases one question rather than two branches.
        var committedBody = DuckDbSql.ScalarString(_connection,
            $"SELECT body FROM {HeadRelation} WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);

        // Computed ahead of the guard because the guard must consult Effective too: a record that
        // never reached Head (straight off CreateWorkingTreeRecord) is exactly as real here, and "no
        // Head answer" must not silently drop its delete or edit.
        var existedBefore = RowExistsAtEffective(key, formKey);

        if (committedBody == null && !existedBefore)
        {
            // Neither ref knows this record. A create is its own gesture and there is nothing here to
            // derive its record_type from, so this is a caller mistake: logged, skipped, never thrown
            // (the seam's missing-data rule).
            _logger.LogWarning(
                "Ignoring a working-tree change for {FormKey}, which {Plugin} ({Origin}) does not hold at any ref",
                formKey, key.Name, key.Origin);
            return false;
        }

        SnapshotCommittedIfFirstDivergence(key, formKey);

        if (body == null)
        {
            // A container's file goes with everything under it, so its children go first, each
            // cascading in turn; a child another container still holds stays.
            foreach (var child in ChildrenRecorded(key, formKey, embeddedIn: null))
            {
                if (RowExistsAtEffective(key, child) && !HeldByAnotherContainer(key, child, formKey))
                    ApplyOneWorkingTreeChange(key, child, null);
            }

            // Deleted in the working tree: gone at Effective — document, lookup row and outgoing
            // references alike — while still answered at Head out of the snapshot. Dropping only the
            // document would leave the record resolvable and in the reference graph.
            DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!);
            DeleteDerivationsForRecord(key, formKey);
            return existedBefore;
        }

        if (string.Equals(body, committedBody, StringComparison.Ordinal))
        {
            // Convergence, not a change (byte compare is the detection). The record goes clean again
            // — including one deleted in the working tree whose file came back, which is why the row
            // is restored from the snapshot rather than updated.
            RestoreFromSnapshot(key, formKey);
            DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.records_committed WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!);
        }
        else
        {
            UpsertEffectiveBody(key, formKey, body);
        }

        RederiveIndexRowsForRecord(key, formKey, body);
        return !existedBefore;
    }

    internal bool RowExistsAtEffective(PluginKey key, string formKey) =>
        DuckDbSql.ScalarString(_connection, "SELECT form_key FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!) != null;

    internal bool RowExistsAtHead(PluginKey key, string formKey) =>
        DuckDbSql.ScalarString(_connection, $"SELECT form_key FROM {HeadRelation} WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!) != null;

    /// <summary>See <see cref="IRecordIndex.CreateWorkingTreeRecord"/>. The both-refs refusal is the
    /// caller's job, run before the transaction this work happens inside.</summary>
    public void CreateWorkingTreeRecord(PluginKey key, string formKey, string recordType, string body)
    {
        InsertNewWorkingTreeRow(key, formKey, recordType, body);
        RederiveIndexRowsForRecord(key, formKey, body);
    }

    // A create writes a row straight to `ref = working-tree` with nothing in records_committed; that
    // omission is what makes records_head answer nothing for this FormKey without the view knowing
    // about creation.
    private void InsertNewWorkingTreeRow(PluginKey key, string formKey, string recordType, string body)
    {
        // ADR-0001: no load_order_idx to carry into the row; this check only refuses a plugin the
        // registration doesn't know.
        if (!IsRegisteredPlugin(key))
            throw new InvalidOperationException($"{key.Name} ({key.Origin}) is not an indexed plugin.");

        InsertRecordRow(key, "mirror.records", SourceRef.WorkingTree, formKey, recordType, body, parseDiagnosis: null);

        // form_lookup's insert-if-absent branch in RederiveIndexRowsForRecord below reads this row
        // back out of `records`, which is why the insert above must land first.
    }

    // Both InsertNewWorkingTreeRow and SeedOneCommittedOnly write through this one column list in
    // one $-binding order, so the two cannot drift apart or leave a column off a row.
    private void InsertRecordRow(
        PluginKey key, string table, string refValue, string formKey, string recordType, string body,
        string? parseDiagnosis)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = $"""
            INSERT INTO {table} ({RecordColumnList})
            VALUES ($1, $2, $3, $4, json_extract_string($5, '$.EditorID'), '{refValue}', $5, $6, $7)
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Origin! });
        cmd.Parameters.Add(new DuckDBParameter { Value = recordType });
        cmd.Parameters.Add(new DuckDBParameter { Value = body });
        cmd.Parameters.Add(new DuckDBParameter { Value = GitBlobHash.Of(Encoding.UTF8.GetBytes(body)) });
        cmd.Parameters.Add(new DuckDBParameter { Value = (object?)parseDiagnosis ?? DBNull.Value });
        cmd.ExecuteNonQuery();
    }

    private bool IsRegisteredPlugin(PluginKey key) =>
        DuckDbSql.ScalarString(_connection,
            $"SELECT plugin FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = $1 AND origin = $2", key.Name, key.Origin!) != null;

    /// <summary>See <see cref="IRecordIndex.SetCommittedBaseline"/>.</summary>
    public void SetCommittedBaseline(PluginKey key, IReadOnlyList<(string FormKey, string Body)> baselines)
    {
        foreach (var (formKey, body) in baselines)
            SetOneCommittedBaseline(key, formKey, body);
    }

    private void SetOneCommittedBaseline(PluginKey key, string formKey, string body)
    {
        var effectiveBody = DuckDbSql.ScalarString(_connection,
            "SELECT body FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        if (effectiveBody == null) return;

        if (string.Equals(effectiveBody, body, StringComparison.Ordinal))
        {
            // The working tree agrees with the new commit, so the record is clean and there is no
            // snapshot to keep — the ordinary "the user committed their edit in a terminal" case.
            DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.records_committed WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!);
            DuckDbSql.ExecuteFor(_connection, $"""
                UPDATE mirror.records SET "ref" = '{SourceRef.Committed}'
                WHERE form_key = $1 AND plugin = $2 AND origin = $3
                """, formKey, key.Name, key.Origin!);
            return;
        }

        // Still dirty against a different baseline. The snapshot may not exist yet (the record was
        // clean and HEAD moved past it), so it is seeded from the Effective row and then overwritten
        // with the committed bytes.
        SnapshotCommittedIfFirstDivergence(key, formKey);
        DuckDbSql.ExecuteFor(_connection, """
            UPDATE mirror.records_committed
            SET body = $4, content_hash = $5, editor_id = json_extract_string($4, '$.EditorID')
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """, formKey, key.Name, key.Origin!, body, GitBlobHash.Of(Encoding.UTF8.GetBytes(body)));
        DuckDbSql.ExecuteFor(_connection, $"""
            UPDATE mirror.records SET "ref" = '{SourceRef.WorkingTree}'
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """, formKey, key.Name, key.Origin!);
    }

    /// <summary>See <see cref="IRecordIndex.MarkWorkingTreeOnly"/>.</summary>
    public void MarkWorkingTreeOnly(PluginKey key, IReadOnlyList<string> formKeys)
    {
        foreach (var formKey in formKeys)
        {
            // The snapshot delete is not padding: a record that diverged earlier in the same load order
            // has one, and a stale snapshot would keep answering at Head through records_head's UNION —
            // the state this method exists to end.
            DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.records_committed WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!);
            DuckDbSql.ExecuteFor(_connection, $"""
                UPDATE mirror.records SET "ref" = '{SourceRef.WorkingTree}'
                WHERE form_key = $1 AND plugin = $2 AND origin = $3
                """, formKey, key.Name, key.Origin!);
        }
    }

    /// <summary>See <see cref="IRecordIndex.SeedCommittedOnly"/>.</summary>
    public void SeedCommittedOnly(PluginKey key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records)
    {
        foreach (var (formKey, recordType, body) in records)
            SeedOneCommittedOnly(key, formKey, recordType, body);
    }

    private void SeedOneCommittedOnly(PluginKey key, string formKey, string recordType, string body)
    {
        if (RowExistsAtEffective(key, formKey) || RowExistsAtHead(key, formKey)) return;

        // ADR-0001: same refusal as InsertNewWorkingTreeRow's.
        if (!IsRegisteredPlugin(key))
            throw new InvalidOperationException($"{key.Name} ({key.Origin}) is not an indexed plugin.");

        // Straight into records_committed with no `records` counterpart — the inverse of
        // InsertNewWorkingTreeRow — which falls out of records_head's definition with no change to
        // that view.
        InsertRecordRow(key, "mirror.records_committed", SourceRef.Committed, formKey, recordType, body, parseDiagnosis: null);
    }

    // Copies the still-clean Effective row aside the first time a record diverges, and does nothing
    // on every later edit of the same record — so the snapshot always holds the *committed* bytes,
    // never the previous working-tree ones.
    private void SnapshotCommittedIfFirstDivergence(PluginKey key, string formKey)
    {
        DuckDbSql.ExecuteFor(_connection, $"""
            INSERT INTO mirror.records_committed ({RecordColumnList})
            SELECT {RecordColumnList} FROM mirror.records r
            WHERE r.form_key = $1 AND r.plugin = $2 AND r.origin = $3 AND r."ref" = '{SourceRef.Committed}'
              AND NOT EXISTS (
                SELECT 1 FROM mirror.records_committed c
                WHERE c.form_key = r.form_key AND c.plugin = r.plugin AND c.origin = r.origin)
            """, formKey, key.Name, key.Origin!);
    }

    private void RestoreFromSnapshot(PluginKey key, string formKey)
    {
        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        DuckDbSql.ExecuteFor(_connection, $"""
            INSERT INTO mirror.records ({RecordColumnList})
            SELECT {RecordColumnList} FROM mirror.records_committed
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """, formKey, key.Name, key.Origin!);
    }

    private void UpsertEffectiveBody(PluginKey key, string formKey, string body)
    {
        var contentHash = GitBlobHash.Of(Encoding.UTF8.GetBytes(body));

        // An UPDATE alone would silently do nothing for a record deleted in the working tree (no
        // Effective row) and then edited back to a different value, so the row is restored from the
        // snapshot first when missing.
        if (DuckDbSql.ScalarString(_connection, "SELECT body FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!) == null)
        {
            RestoreFromSnapshot(key, formKey);
        }

        // editor_id follows the body: it is a projection of the document; otherwise a renamed record
        // would keep listing under its old EditorID. record_type is not re-derived: a record cannot
        // change type.
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = $"""
            UPDATE mirror.records
            SET body = $4, content_hash = $5, "ref" = '{SourceRef.WorkingTree}',
                editor_id = json_extract_string($4, '$.EditorID')
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """;
        DuckDbSql.AddParams(cmd, [formKey, key.Name, key.Origin!, body, contentHash]);
        cmd.ExecuteNonQuery();
    }

    // ADR-0041: the extracted tables are derived from the document, never written independently of
    // it. Rebuilt for one record through the same collectors ingest uses, so an edit cannot leave
    // derived answers describing bytes that are gone.
    private void RederiveIndexRowsForRecord(PluginKey key, string formKey, string body)
    {
        var recordType = DuckDbSql.ScalarString(_connection,
            "SELECT record_type FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        if (recordType == null || !_schemas.TryGetValue(recordType, out var schema)) return;

        // form_lookup is *updated*, not delete-then-inserted: record_type cannot change, so editor_id
        // is the whole delta, and a delete-then-insert would be two statements doing one statement's
        // work on the hot per-edit path.
        DuckDbSql.ExecuteFor(_connection, """
            UPDATE mirror.form_lookup SET editor_id = json_extract_string($4, '$.EditorID')
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """, formKey, key.Name, key.Origin!, body);

        // The row is absent when this record was deleted in the working tree and has come back — the
        // one case where there is nothing to update.
        DuckDbSql.ExecuteFor(_connection, $"""
            INSERT INTO mirror.form_lookup (form_key, plugin, origin, record_type, editor_id)
            SELECT r.form_key, r.plugin, r.origin, r.record_type, r.editor_id
            FROM mirror.records r
            WHERE r.form_key = $1 AND r.plugin = $2 AND r.origin = $3
              AND NOT EXISTS (
                SELECT 1 FROM mirror.form_lookup l
                WHERE l.form_key = r.form_key AND l.plugin = r.plugin AND l.origin = r.origin)
            """, formKey, key.Name, key.Origin!);

        // The header carries no reference graph (masters are a plugin-dependency list, not FormKey
        // references), and a ModHeader cannot go through the per-record codec below, so this stops
        // after the identity-only update, clearing stale form_references.
        if (recordType == HeaderIndexer.RecordType)
        {
            DeleteFormReferencesForRecord(key, formKey);
            return;
        }

        var refs = new List<FormRef>();
        using (var document = JsonDocument.Parse(body))
        {
            var root = document.RootElement;
            PluginIngest.CollectFormRefs(
                refs, formKey, DocumentNodes.At(root, "EditorID")?.GetString(), root, recordType, schema);
        }

        DeleteFormReferencesForRecord(key, formKey);
        if (refs.Count > 0)
        {
            using var refAppender = _connection.CreateAppender("mirror", "form_references");
            foreach (var r in refs)
                PluginIngest.AppendFormReference(refAppender, r, key.Name, key.Origin!);
        }

        // placement/cell_location/container_child track Effective the same way
        // form_lookup/form_references do, rebuilt from the record the body reads back into: a
        // container's child slots are walked through Mutagen's own object model.
        var record = _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(body), _release, recordType)
            .GetAwaiter().GetResult();
        var containerType = ContainerChildFields.NormalizedTypeName(record.GetType());
        var recordedBefore = ChildrenRecorded(key, formKey, embeddedIn: containerType);
        DeriveEmbeddedChildRows(key, record);
        RederiveContainmentForRecord(key, formKey, recordType, record);

        // A child absent from the document is gone at Effective, unless another container's document
        // holds it (a renumbered container re-derives its children under the new identity first).
        var carriedNow = ContainerChildFields.EnumerateChildren(record)
            .Where(c => ContainerChildFields.EmbeddedSlots.Contains((containerType, c.SlotName)))
            .Select(c => c.Child.FormKey.ToString())
            .ToHashSet(StringComparer.Ordinal);
        foreach (var gone in recordedBefore.Where(fk => !carriedNow.Contains(fk)))
        {
            if (RowExistsAtEffective(key, gone) && !HeldByAnotherContainer(key, gone, formKey))
                ApplyOneWorkingTreeChange(key, gone, null);
        }
    }

    // The children last recorded under this container. embeddedIn names the container's type and
    // keeps only the children its document carries; null takes every child, the set a deleted
    // directory held.
    private List<string> ChildrenRecorded(PluginKey key, string parentFormKey, string? embeddedIn)
    {
        var recorded = new List<string>();
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = """
            SELECT form_key, NULL, NULL FROM mirror.placement WHERE parent_cell = $1 AND plugin = $2 AND origin = $3
            UNION ALL
            SELECT cell_form_key, NULL, block_x FROM mirror.cell_location
            WHERE parent_worldspace = $1 AND plugin = $2 AND origin = $3
            UNION ALL
            SELECT child_form_key, slot_name, NULL FROM mirror.container_child
            WHERE parent_form_key = $1 AND plugin = $2 AND origin = $3
            """;
        DuckDbSql.AddParams(cmd, [parentFormKey, key.Name, key.Origin!]);
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            var embedded = embeddedIn == null
                || (reader.IsDBNull(1) || ContainerChildFields.EmbeddedSlots.Contains((embeddedIn, reader.GetString(1))))
                    && reader.IsDBNull(2);
            if (embedded) recorded.Add(reader.GetString(0));
        }
        return recorded;
    }

    private bool HeldByAnotherContainer(PluginKey key, string childFormKey, string thisParentFormKey) =>
        DuckDbSql.ScalarString(_connection, """
            SELECT form_key FROM mirror.placement
            WHERE form_key = $1 AND parent_cell <> $2 AND plugin = $3 AND origin = $4
            UNION ALL
            SELECT cell_form_key FROM mirror.cell_location
            WHERE cell_form_key = $1 AND parent_worldspace <> $2 AND plugin = $3 AND origin = $4
            UNION ALL
            SELECT child_form_key FROM mirror.container_child
            WHERE child_form_key = $1 AND parent_form_key <> $2 AND plugin = $3 AND origin = $4
            LIMIT 1
            """, childFormKey, thisParentFormKey, key.Name, key.Origin!) != null;

    // An embedded child's own row is a projection of its container's document, like its placement
    // row: serialized out of the container's graph through the codec ingest uses. No schema, no
    // row, as at ingest.
    private void DeriveEmbeddedChildRows(PluginKey key, IMajorRecordGetter container)
    {
        var containerType = ContainerChildFields.NormalizedTypeName(container.GetType());
        foreach (var (slotName, _, child) in ContainerChildFields.EnumerateChildren(container))
        {
            if (!ContainerChildFields.EmbeddedSlots.Contains((containerType, slotName))) continue;
            var childType = SourceRecordType.Resolve(child, _schemas);
            if (!_schemas.ContainsKey(childType)) continue;

            var childFormKey = child.FormKey.ToString();
            var childBody = Encoding.UTF8.GetString(_codec.SerializeToBytesAsync(child, _release).GetAwaiter().GetResult());
            if (string.Equals(childBody, EffectiveBody(key, childFormKey), StringComparison.Ordinal)) continue;

            if (RowExistsAtEffective(key, childFormKey) || RowExistsAtHead(key, childFormKey))
                ApplyOneWorkingTreeChange(key, childFormKey, childBody);
            else
                CreateWorkingTreeRecord(key, childFormKey, childType, childBody);
        }
    }

    private string? EffectiveBody(PluginKey key, string formKey) =>
        DuckDbSql.ScalarString(_connection, "SELECT body FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);

    // A container's child set and slot order live in its body, so a delete-then-insert per (parent,
    // table) is correct by construction. An embedded child that is itself a container derives its
    // own containment through its own row.
    private void RederiveContainmentForRecord(PluginKey key, string formKey, string recordType, IMajorRecordGetter record)
    {
        // Two spellings of the type: the CLR name (Cell) is what CoveredByPlacementTables and
        // EnumerateChildren key off; the schema table name (cell) is what a stored
        // ContainerChildRow.ParentRecordType carries, matching ingest and downstream readers.
        var slotLookupType = ContainerChildFields.NormalizedTypeName(record.GetType());
        var containerChildRows = new List<ContainerChildRow>();
        var placementRows = new List<PlacementRow>();
        CellLocationRow? topCellRow = null;

        foreach (var (slotName, slotIndex, child) in ContainerChildFields.EnumerateChildren(record))
        {
            if (!PluginIngest.CoveredByPlacementTables.Contains((slotLookupType, slotName)))
            {
                containerChildRows.Add(new ContainerChildRow(
                    child.FormKey.ToString(), formKey, recordType, slotName, slotIndex));
                continue;
            }

            switch (slotName)
            {
                case "Persistent":
                    placementRows.Add(_placementWalker.EmitPlacementRow(child, formKey, "persistent"));
                    break;
                case "Temporary":
                    placementRows.Add(_placementWalker.EmitPlacementRow(child, formKey, "temporary"));
                    break;
                case "TopCell":
                    // No block/sub and never interior, by construction — a worldspace's top cell is
                    // not part of any exterior grid.
                    topCellRow = _placementWalker.EmitCellLocationRow(
                        child, formKey, blockX: null, blockY: null, subX: null, subY: null, isInterior: false);
                    break;
                    // "SubCells": never yielded here — its items are WorldspaceBlock, which is not
                    // IMajorRecordGetter.
            }
        }

        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.container_child WHERE parent_form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        if (containerChildRows.Count > 0)
        {
            using var appender = _connection.CreateAppender("mirror", "container_child");
            foreach (var row in containerChildRows)
                PluginIngest.AppendContainerChildRow(appender, row, key.Name, key.Origin!);
        }

        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.placement WHERE parent_cell = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        if (placementRows.Count > 0)
        {
            using var appender = _connection.CreateAppender("mirror", "placement");
            foreach (var row in placementRows)
                PluginIngest.AppendPlacementRow(appender, row, key.Name, key.Origin!);
        }

        if (topCellRow is not { } cellRow) return;

        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.cell_location WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3",
            cellRow.CellFormKey, key.Name, key.Origin!);
        using var cellLocationAppender = _connection.CreateAppender("mirror", "cell_location");
        PluginIngest.AppendCellLocationRow(cellLocationAppender, cellRow, key.Name, key.Origin!);
    }

    private void DeleteDerivationsForRecord(PluginKey key, string formKey)
    {
        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.form_lookup WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        DeleteFormReferencesForRecord(key, formKey);
        DeleteContainmentForRecord(key, formKey);
    }

    private void DeleteFormReferencesForRecord(PluginKey key, string formKey) =>
        DuckDbSql.ExecuteFor(_connection,
            "DELETE FROM mirror.form_references WHERE source_form_key = $1 AND source_plugin = $2 AND source_origin = $3",
            formKey, key.Name, key.Origin!);

    // Its own facts plus, as a backstop, whatever names it as a parent: DeleteRecord's descendant
    // cascade already gives every descendant its own null-body delta, so a deleted container's
    // children lose their rows via their own deletion.
    private void DeleteContainmentForRecord(PluginKey key, string formKey)
    {
        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.placement WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.placement WHERE parent_cell = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.cell_location WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.container_child WHERE child_form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.container_child WHERE parent_form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
    }
}
