using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>
/// The working-tree overlay collaborator of <see cref="DuckDbRecordIndex"/>
/// — <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>/<see cref="IRecordIndex.SetCommittedBaseline"/>/
/// <see cref="IRecordIndex.MarkWorkingTreeOnly"/>/<see cref="IRecordIndex.SeedCommittedOnly"/>/
/// <see cref="IRecordIndex.CreateWorkingTreeRecord"/> and the per-record rederivation
/// (<c>form_lookup</c>/<c>form_references</c>/<c>placement</c>/<c>cell_location</c>/<c>container_child</c>)
/// every one of them drives. Internal, private to the <c>Records</c> module — not part of any public
/// seam.
///
/// <para><b>Depends on <see cref="PluginIngest"/>, one-directionally</b>:
/// rederivation reuses ingest's own collectors (<see cref="PluginIngest.CollectFormRefs"/>/
/// <see cref="PluginIngest.CollectVmadRefsForRecord"/>/<see cref="PluginIngest.CollectConditionRefsForRecord"/>)
/// and append primitives, deliberately — an edit's derived rows must come from the identical code a
/// fresh ingest would produce them with, or the two could drift apart. PluginIngest never
/// references this class back.</para>
///
/// <para><b>Does not own the winner sweep or the transaction/commit boundary.</b> Every public method
/// here reports whether it needs a resweep (or the caller already knows, the way a create always
/// does) rather than calling <see cref="DuckDbRecordIndex.UpdateWinners"/> itself — that stays this
/// class's own cross-cutting responsibility, the same "compute here, act at the caller" shape
/// <see cref="IndexStore.ValidateAgainstDisk"/> uses for the identical reason: a callback back into
/// the caller is a seam whose only job is breaking a cycle nobody needed to create.
/// <see cref="DuckDbRecordIndex"/> owns every transaction and the early "nothing to do" guards
/// (including <see cref="RowExistsAtEffective"/>/
/// <see cref="RowExistsAtHead"/> running before any transaction opens for
/// <see cref="IRecordIndex.CreateWorkingTreeRecord"/>'s refusal).</para>
/// </summary>
internal sealed class WorkingTreeOverlay
{
    private const string HeadRelation = "records_head";

    // The columns `records` and `records_committed` share, in declaration order — named rather than
    // SELECT *'d so the snapshot copy below is pinned to a column list instead of to the two tables
    // happening to stay in the same order forever.
    private const string RecordColumnList =
        "form_key, plugin, origin, record_type, editor_id, \"ref\", body, content_hash";

    private readonly DuckDBConnection _connection;
    private readonly ILogger _logger;
    private readonly RecordTextCodec _codec;
    private readonly PlacementWalker _placementWalker;
    private readonly PluginIngest _pluginIngest;
    private readonly GameRelease _release;
    private readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas;

    public WorkingTreeOverlay(
        DuckDBConnection connection, ILogger logger, RecordTextCodec codec, PlacementWalker placementWalker,
        PluginIngest pluginIngest, GameRelease release, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        _connection = connection;
        _logger = logger;
        _codec = codec;
        _placementWalker = placementWalker;
        _pluginIngest = pluginIngest;
        _release = release;
        _schemas = schemas;
    }

    /// <summary>See <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>. Returns whether any delta in
    /// the batch added or removed an Effective row — <see cref="DuckDbRecordIndex.ApplyWorkingTreeChanges"/>
    /// resweeps winners on that answer.</summary>
    public bool ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        var structural = false;
        foreach (var (formKey, body) in deltas)
            structural |= ApplyOneWorkingTreeChange(key, formKey, body);
        return structural;
    }

    /// <summary>Applies one delta. Returns true when it added or removed an Effective row — a
    /// <i>structural</i> change, the only kind that can move winner status.</summary>
    private bool ApplyOneWorkingTreeChange(PluginKey key, string formKey, string? body)
    {
        // The committed bytes, wherever they currently live: the snapshot if this record already
        // diverged, else the still-clean Effective row itself. Reading through the Head relation is
        // what makes those two cases one question rather than two branches that could drift apart.
        var committedBody = DuckDbSql.ScalarString(_connection,
            $"SELECT body FROM {HeadRelation} WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);

        // Computed ahead of the guard below because the
        // guard itself must consult Effective too — a record that never reached Head at all (still
        // working-tree-only, e.g. straight off CreateWorkingTreeRecord) is exactly as real to this
        // method as one that has; assuming "no Head answer" means "no ref answers" would silently
        // drop both a delete (renumber's own "delete old FormKey" half) and an edit of such a record.
        var existedBefore = RowExistsAtEffective(key, formKey);

        if (committedBody == null && !existedBefore)
        {
            // Neither ref knows this record. A create is a lifecycle gesture with its own ticket, and
            // there is nothing here to derive its record_type/load_order_idx from, so this is a
            // caller mistake rather than a state to invent — logged, skipped, never thrown (the
            // seam's missing-data rule).
            _logger.LogWarning(
                "Ignoring a working-tree change for {FormKey}, which {Plugin} ({Origin}) does not hold at any ref",
                formKey, key.Name, key.Origin);
            return false;
        }

        SnapshotCommittedIfFirstDivergence(key, formKey);

        if (body == null)
        {
            // Deleted in the working tree: gone at Effective — document, lookup row and outgoing
            // references alike — while still answered at Head out of the snapshot taken immediately
            // above. Dropping only the document would leave the record resolvable and still sitting
            // in the reference graph, i.e. present in every derived answer and absent from the one
            // that stores it.
            DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!);
            DeleteDerivationsForRecord(key, formKey);
            return existedBefore;
        }

        if (string.Equals(body, committedBody, StringComparison.Ordinal))
        {
            // Convergence, not a change (byte compare is the detection). The record goes clean
            // again — including the case where it was *deleted* in the working tree and the file came
            // back, which is why this restores the row from the snapshot rather than assuming one is
            // still there to update.
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

    /// <summary>Whether <paramref name="key"/> holds <paramref name="formKey"/> at Effective. Internal:
    /// <see cref="DuckDbRecordIndex.CreateWorkingTreeRecord"/> calls this (with <see cref="RowExistsAtHead"/>)
    /// for its refusal check <b>before</b> opening a transaction.</summary>
    internal bool RowExistsAtEffective(PluginKey key, string formKey) =>
        DuckDbSql.ScalarString(_connection, "SELECT form_key FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!) != null;

    internal bool RowExistsAtHead(PluginKey key, string formKey) =>
        DuckDbSql.ScalarString(_connection, $"SELECT form_key FROM {HeadRelation} WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!) != null;

    /// <summary>See <see cref="IRecordIndex.CreateWorkingTreeRecord"/>. The refusal check
    /// (<see cref="RowExistsAtEffective"/>/<see cref="RowExistsAtHead"/>) is the caller's own job,
    /// run before the transaction this method's work happens inside of — see this class's own doc
    /// comment.</summary>
    public void CreateWorkingTreeRecord(PluginKey key, string formKey, string recordType, string body)
    {
        InsertNewWorkingTreeRow(key, formKey, recordType, body);
        RederiveIndexRowsForRecord(key, formKey, body);
    }

    // No existing Effective row to restore from and no committed snapshot to seed — a create writes
    // a row from scratch, straight to `ref = working-tree`, with nothing in records_committed. That
    // omission is exactly what makes records_head (records_committed UNION clean committed rows)
    // answer nothing for this FormKey without the view itself needing to know about creation at all.
    private void InsertNewWorkingTreeRow(PluginKey key, string formKey, string recordType, string body)
    {
        // ADR-0001: no load_order_idx to carry into the row — this check exists
        // purely to refuse a plugin the registration doesn't know, which
        // InsertNewWorkingTreeRow's callers (CreateWorkingTreeRecord) rely on.
        if (!IsRegisteredPlugin(key))
            throw new InvalidOperationException($"{key.Name} ({key.Origin}) is not an indexed plugin.");

        InsertRecordRow(key, "mirror.records", SourceRef.WorkingTree, formKey, recordType, body);

        // form_lookup's insert-if-absent branch in RederiveIndexRowsForRecord below reads this row
        // back out of `records`, which is why the insert above must land first.
    }

    // The parameterized INSERT both InsertNewWorkingTreeRow and SeedOneCommittedOnly need — same
    // eight columns in the same $-binding order, differing only in which table the row lands in and
    // which SourceRef literal it is stamped with. Extracted so the two cannot drift into appending
    // different column orders, the same reasoning PluginIngest's own AppendXRow primitives are
    // extracted for.
    private void InsertRecordRow(PluginKey key, string table, string refValue, string formKey, string recordType, string body)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = $"""
            INSERT INTO {table} (form_key, plugin, origin, record_type, editor_id, "ref", body, content_hash)
            VALUES ($1, $2, $3, $4, json_extract_string($5, '$.EditorID'), '{refValue}', $5, $6)
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Origin! });
        cmd.Parameters.Add(new DuckDBParameter { Value = recordType });
        cmd.Parameters.Add(new DuckDBParameter { Value = body });
        cmd.Parameters.Add(new DuckDBParameter { Value = GitBlobHash.Of(Encoding.UTF8.GetBytes(body)) });
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

        // Still dirty, but against a different baseline than before. The snapshot may not exist yet
        // (the record was clean and HEAD moved past it), so it is seeded from the Effective row first
        // and then overwritten with the committed bytes — only the body moved, so every identity
        // column is the same either way.
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
            // The snapshot delete is not defensive padding: a fresh ingest leaves none behind, but this
            // is also reachable for a record that diverged earlier in the same load order, and a stale
            // snapshot would keep answering at Head through records_head's own UNION — which is exactly
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

        // Straight into records_committed with no `records` counterpart — the exact inverse of
        // InsertNewWorkingTreeRow's "records row with no snapshot", and it falls out of records_head's
        // existing definition (the snapshot table UNION the still-clean rows) with no change to that
        // view: present in its first half, absent from its second.
        InsertRecordRow(key, "mirror.records_committed", SourceRef.Committed, formKey, recordType, body);
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

        // An UPDATE alone would silently do nothing for a record the working tree had previously
        // deleted (no Effective row to update) and then edited back to a *different* value — so the
        // row is restored from the snapshot first when it is missing, and only then rewritten.
        if (DuckDbSql.ScalarString(_connection, "SELECT body FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!) == null)
        {
            RestoreFromSnapshot(key, formKey);
        }

        // editor_id follows the body rather than being left at its committed value: it is a
        // *projection* of the document (the codec writes EditorID at the document's top level), and a
        // row whose identity column disagrees with its own body is a read model contradicting itself
        // — a renamed record would keep listing and resolving under its old EditorID everywhere
        // form_key isn't the lookup key. record_type is deliberately not re-derived: a record cannot
        // change type. Load order and winning are not on this row at all (ADR-0001) — they
        // are facts about the plugin and the stack, not about these bytes.
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

    // The extracted index tables (ADR-0041: form_lookup and form_references are derived *from* the
    // document, never written independently of it) for one record, rebuilt from the bytes that just
    // landed. Ingest does exactly this per record inside its own per-plugin loop; here it happens for
    // one record at a time, through the same collectors, so an edit cannot leave the derived answers
    // describing bytes that no longer exist.
    private void RederiveIndexRowsForRecord(PluginKey key, string formKey, string body)
    {
        var recordType = DuckDbSql.ScalarString(_connection,
            "SELECT record_type FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        if (recordType == null || !_schemas.TryGetValue(recordType, out var schema)) return;

        // form_lookup is *updated*, not delete-then-inserted: record_type cannot change (a record
        // does not change type), so editor_id is the whole delta, and a delete-then-insert would be
        // two statements doing one statement's work on the hot per-edit path.
        DuckDbSql.ExecuteFor(_connection, """
            UPDATE mirror.form_lookup SET editor_id = json_extract_string($4, '$.EditorID')
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """, formKey, key.Name, key.Origin!, body);

        // The row is absent when this record was previously deleted in the working tree and has now
        // come back — the one case where there is nothing to update.
        DuckDbSql.ExecuteFor(_connection, $"""
            INSERT INTO mirror.form_lookup (form_key, plugin, origin, record_type, editor_id)
            SELECT r.form_key, r.plugin, r.origin, r.record_type, r.editor_id
            FROM mirror.records r
            WHERE r.form_key = $1 AND r.plugin = $2 AND r.origin = $3
              AND NOT EXISTS (
                SELECT 1 FROM mirror.form_lookup l
                WHERE l.form_key = r.form_key AND l.plugin = r.plugin AND l.origin = r.origin)
            """, formKey, key.Name, key.Origin!);

        var record = _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(body), _release, recordType)
            .GetAwaiter().GetResult();

        var refs = new List<FormRef>();
        // Through PluginIngest — Overlay depends on Ingest for the collectors so a
        // per-record rederivation cannot describe a different graph than a fresh ingest would.
        PluginIngest.CollectFormRefs(refs, record, recordType, schema);
        PluginIngest.CollectVmadRefsForRecord(record, recordType, refs);
        _pluginIngest.CollectConditionRefsForRecord(record, recordType, refs);

        DeleteFormReferencesForRecord(key, formKey);
        if (refs.Count > 0)
        {
            using var refAppender = _connection.CreateAppender("mirror", "form_references");
            foreach (var r in refs)
                PluginIngest.AppendFormReference(refAppender, r, key.Name, key.Origin!);
        }

        // placement/cell_location/container_child track Effective the same way
        // form_lookup/form_references do — rebuilt from this same deserialized record,
        // through the same collectors ingest's own AppendDocument/IndexPlacement use.
        RederiveContainmentForRecord(key, formKey, recordType, record);
    }

    /// <summary>
    /// Rebuilds <c>container_child</c>/<c>placement</c>/<c>cell_location</c> for whatever
    /// <paramref name="record"/>'s own document embeds — a container's child <i>set</i> and slot
    /// order live entirely in the parent's own body (<see cref="ContainerChildFields.EnumerateChildren"/>
    /// re-reads current positions on every call), so a delete or a renumber that spliced/mutated that
    /// body is reflected here without any separate "what moved" bookkeeping. A full delete-then-insert
    /// per (parent, table) — cheap (one record's children, never the whole plugin) and correct by
    /// construction: the values are identical to what a fresh ingest of this same body would produce.
    ///
    /// <para>Recurses exactly one level, into a <c>Worldspace.TopCell</c> — the same bound
    /// <c>ContainerChildFields.FindEmbeddedChildSlot</c> already documents
    /// (<c>EmbeddedSlots</c>): nothing else embeds a container inside a container, so a placed
    /// reference two levels inside a worldspace's document (the shape
    /// <c>EmbeddedChildEditTests.APlacedRefInsideAWorldspacesTopCell_IsEditable_TwoEmbedLevelsDeepInOneFile</c>
    /// exercises) still gets a current <c>placement</c> row.</para>
    ///
    /// <para>Harmless to call for a non-container record (most calls): <see cref="ContainerChildFields.EnumerateChildren"/>
    /// yields nothing, both deletes below match no rows, and nothing is inserted — the same
    /// "unreachable by construction" posture <c>RecordEditService</c>'s own containment guard relies
    /// on for the field-edit path.</para>
    /// </summary>
    private void RederiveContainmentForRecord(PluginKey key, string formKey, string recordType, IMajorRecordGetter record)
    {
        // Two different spellings of "what type is this", each answering to a different consumer:
        // the CLR-name form (Cell, Worldspace) is what PluginIngest.CoveredByPlacementTables and
        // ContainerChildFields.EnumerateChildren key off; the schema-table-name form (cell, "cell") is
        // what a stored ContainerChildRow.ParentRecordType must carry, because that is what
        // AppendDocument's own ingest-time row already stores and what downstream readers
        // (SourceUnitResolver.ScanSubtree's RecordTypeDispatch lookups) compare against.
        var slotLookupType = ContainerChildFields.NormalizedTypeName(record.GetType());
        var containerChildRows = new List<ContainerChildRow>();
        var placementRows = new List<PlacementRow>();
        CellLocationRow? topCellRow = null;
        IMajorRecordGetter? topCellRecord = null;

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
                    // not part of any exterior grid (PlacementWalker.WalkWorldspace's own ingest walk
                    // uses these same three constants for the identical reason).
                    topCellRow = _placementWalker.EmitCellLocationRow(
                        child, formKey, blockX: null, blockY: null, subX: null, subY: null, isInterior: false);
                    topCellRecord = child;
                    break;
                    // "SubCells": never yielded here — its items are WorldspaceBlock, which is not
                    // IMajorRecordGetter (ContainerChildFields.EnumerateChildren's own doc comment).
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

        if (topCellRow is not { } cellRow || topCellRecord == null) return;

        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.cell_location WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3",
            cellRow.CellFormKey, key.Name, key.Origin!);
        using (var appender = _connection.CreateAppender("mirror", "cell_location"))
            PluginIngest.AppendCellLocationRow(appender, cellRow, key.Name, key.Origin!);

        // The top cell is itself a container (its own Persistent/Temporary/Landscape/
        // NavigationMeshes), one level deeper in the very same document. "cell" is the schema
        // table name a Cell's own GRUP signature ("CELL") always lowercases to — a TopCell slot can
        // only ever hold a Cell, so this is not a guess the way a general record's recordType would be.
        RederiveContainmentForRecord(key, cellRow.CellFormKey, "cell", topCellRecord);
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

    /// <summary>
    /// The three side tables' rows for a record that just stopped existing at Effective — its
    /// own facts (a placed ref's <c>placement</c> row, a cell's <c>cell_location</c> row, a
    /// folder-split child's <c>container_child</c> row), plus, defensively, whatever names it as a
    /// parent. The defensive half is a backstop, not the primary mechanism: <c>DeleteRecord</c>'s own
    /// descendant cascade (<c>EnumerateDescendantFormKeys</c>) already gives every descendant its own
    /// null-body delta, which reaches this same method for each of them individually — so a deleted
    /// container's children lose their rows via their <i>own</i> deletion, not by this record's
    /// parent-side cleanup alone.
    /// </summary>
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
