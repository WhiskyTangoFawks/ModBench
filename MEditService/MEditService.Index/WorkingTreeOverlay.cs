using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>The working-tree overlay collaborator of <see cref="Store"/>, which owns
/// every transaction and the winner sweep. Uses <c>PluginIngest</c>'s collectors so an edit's
/// derived rows cannot drift from ingest's.</summary>
internal sealed class WorkingTreeOverlay
{
    private readonly DuckDBConnection _connection;
    private readonly ILogger _logger;
    private readonly ContainerDocuments _containers;
    private readonly PluginIngest _ingest;
    private readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas;
    private readonly RecordTypes _types;

    public WorkingTreeOverlay(
        DuckDBConnection connection, ILogger logger, IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        _connection = connection;
        _logger = logger;
        _containers = new ContainerDocuments(release);
        _ingest = new PluginIngest(connection, logger, release);
        _types = RecordTypes.For(release);
        _schemas = schemas;
    }

    /// <summary>Folds re-derived documents into the read model: null Body deletes, byte-equal body
    /// converges. <c>Structural</c> is an Effective row added or removed, which winners resweep on;
    /// <c>Touched</c> is every key whose rows moved.</summary>
    public (bool Structural, List<string> Touched) ProjectDocuments(
        PluginAddress key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        var structural = false;
        // The deltas' own keys are named whether or not their bytes moved: the caller asked about
        // them, and a subscriber re-reading one it was told about costs one query.
        var touched = new List<string>(deltas.Select(d => d.FormKey));
        foreach (var (formKey, body) in deltas)
            structural |= ApplyOneWorkingTreeChange(key, formKey, body, touched);
        return (structural, touched);
    }

    // Returns true when it added or removed an Effective row — a structural change, the only kind
    // that can move winner status. touched collects every key whose rows this call moved.
    private bool ApplyOneWorkingTreeChange(PluginAddress key, string formKey, string? body, ICollection<string> touched)
    {
        var existedBefore = RowExistsAtEffective(key, formKey);

        if (!existedBefore)
        {
            // A create is its own gesture and there is nothing here to derive its record_type from, so
            // this is a caller mistake: logged, skipped, never thrown (the seam's missing-data rule).
            if (body != null)
            {
                _logger.LogWarning(
                    "Ignoring a working-tree change for {FormKey}, which {Plugin} ({Origin}) does not hold",
                    formKey, key.Name, key.Origin);
            }
            return false;
        }

        if (body == null)
        {
            // A container's file goes with everything under it, so its children go first, each
            // cascading in turn; a child another container still holds stays.
            foreach (var child in ChildrenRecorded(key, formKey, embeddedIn: null))
            {
                if (RowExistsAtEffective(key, child) && !HeldByAnotherContainer(key, child, formKey))
                {
                    touched.Add(child);
                    ApplyOneWorkingTreeChange(key, child, null, touched);
                }
            }

            // Gone: document and derived rows alike. Dropping only the document would leave the
            // record in the reference graph.
            DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin);
            DeleteDerivationsForRecord(key, formKey);
            return true;
        }

        UpsertEffectiveBody(key, formKey, body);
        RederiveIndexRowsForRecord(key, formKey, body, touched);
        return false;
    }

    internal bool RowExistsAtEffective(PluginAddress key, string formKey) =>
        DuckDbSql.ScalarString(_connection, "SELECT form_key FROM mirror.records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin) != null;

    // A record the index does not hold, materialized: the shape an embedded child re-derived out of a
    // container's document arrives in.
    private void MaterializeRecord(
        PluginAddress key, string formKey, string recordType, string body, ICollection<string> touched)
    {
        InsertNewWorkingTreeRow(key, formKey, recordType, body);
        RederiveIndexRowsForRecord(key, formKey, body, touched);
    }

    private void InsertNewWorkingTreeRow(PluginAddress key, string formKey, string recordType, string body)
    {
        // ADR-0012: no load_order_idx to carry into the row; this check only refuses a
        // plugin the registration doesn't know.
        if (!IsRegisteredPlugin(key))
            throw new InvalidOperationException($"{key.Name} ({key.Origin}) is not an indexed plugin.");

        using var cmd = _connection.CreateCommand();
        cmd.CommandText = """
            INSERT INTO mirror.records (form_key, plugin, origin, record_type, editor_id, body, content_hash)
            VALUES ($1, $2, $3, $4, json_extract_string($5, '$.EditorID'), $5, $6)
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Origin });
        cmd.Parameters.Add(new DuckDBParameter { Value = recordType });
        cmd.Parameters.Add(new DuckDBParameter { Value = body });
        cmd.Parameters.Add(new DuckDBParameter { Value = SourceRepository.ContentStamp(body) });
        cmd.ExecuteNonQuery();
    }

    private bool IsRegisteredPlugin(PluginAddress key) =>
        DuckDbSql.ScalarString(_connection,
            $"SELECT plugin FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = $1 AND origin = $2", key.Name, key.Origin) != null;

    private void UpsertEffectiveBody(PluginAddress key, string formKey, string body)
    {
        // editor_id follows the body: it is a projection of the document; otherwise a renamed record
        // would keep listing under its old EditorID. record_type is not re-derived: a record cannot
        // change type.
        DuckDbSql.ExecuteFor(_connection, """
            UPDATE mirror.records
            SET body = $4, content_hash = $5, editor_id = json_extract_string($4, '$.EditorID')
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """, formKey, key.Name, key.Origin, body, SourceRepository.ContentStamp(body));
    }

    // Rebuilt for one record through the same collectors ingest uses, so an edit cannot
    // leave derived answers describing bytes that are gone.
    private void RederiveIndexRowsForRecord(PluginAddress key, string formKey, string body, ICollection<string> touched)
    {
        var recordType = DuckDbSql.ScalarString(_connection,
            "SELECT record_type FROM mirror.records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin);
        if (recordType == null || !_schemas.TryGetValue(recordType, out var schema)) return;

        // The header carries no reference graph (masters are a plugin-dependency list, not FormKey
        // references), and a ModHeader cannot go through the per-record codec below, so this stops
        // after clearing stale form_references.
        if (recordType == PluginHeader.RecordType)
        {
            DeleteFormReferencesForRecord(key, formKey);
            return;
        }

        var prepared = _ingest.PrepareRecord(new PluginDocument(recordType, formKey, body), schema);
        List<ContainerDocuments.ChildDocument> children = [.. _containers.ChildrenOf(recordType, Document.Parse(body))];

        DeleteFormReferencesForRecord(key, formKey);
        if (prepared.Refs.Count > 0)
        {
            using var refAppender = _connection.CreateAppender("mirror", "form_references");
            foreach (var r in prepared.Refs)
                PluginIngest.AppendFormReference(refAppender, r, key.Name, key.Origin);
        }

        // holdings and cell_location track Effective the same way form_references does, rebuilt
        // from the child documents this body carries.
        var recordedBefore = ChildrenRecorded(key, formKey, embeddedIn: recordType);
        DeriveEmbeddedChildRows(key, recordType, children, touched);
        RederiveContainmentForRecord(key, formKey, prepared);

        // A child absent from the document is gone at Effective, unless another container's document
        // holds it (a container whose FormID changed re-derives its children under the new identity first).
        var carriedNow = children
            .Where(c => _types.IsEmbeddedSlot(recordType, c.SlotName))
            .Select(c => c.FormKey)
            .ToHashSet(StringComparer.Ordinal);
        foreach (var gone in recordedBefore.Where(fk => !carriedNow.Contains(fk)))
        {
            if (RowExistsAtEffective(key, gone) && !HeldByAnotherContainer(key, gone, formKey))
            {
                touched.Add(gone);
                ApplyOneWorkingTreeChange(key, gone, null, touched);
            }
        }
    }

    // The children last recorded under this container. embeddedIn names the container's type and
    // keeps only the children its document carries; null takes every child, the set a deleted
    // directory held.
    private List<string> ChildrenRecorded(PluginAddress key, string parentFormKey, string? embeddedIn)
    {
        var recorded = new List<string>();
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = "SELECT child, slot FROM mirror.holdings WHERE parent = $1 AND plugin = $2 AND origin = $3";
        DuckDbSql.AddParams(cmd, [parentFormKey, key.Name, key.Origin]);
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            if (embeddedIn == null || _types.IsEmbeddedSlot(embeddedIn, reader.GetString(1)))
                recorded.Add(reader.GetString(0));
        }
        return recorded;
    }

    private bool HeldByAnotherContainer(PluginAddress key, string childFormKey, string thisParentFormKey) =>
        DuckDbSql.ScalarString(_connection, """
            SELECT child FROM mirror.holdings
            WHERE child = $1 AND parent <> $2 AND plugin = $3 AND origin = $4
            LIMIT 1
            """, childFormKey, thisParentFormKey, key.Name, key.Origin) != null;

    // An embedded child's own row is a projection of its container's document, like its placement
    // row: serialized out of the container's graph through the codec ingest uses.
    private void DeriveEmbeddedChildRows(
        PluginAddress key, string recordType, IReadOnlyList<ContainerDocuments.ChildDocument> children,
        ICollection<string> touched)
    {
        foreach (var child in children)
        {
            if (!_types.IsEmbeddedSlot(recordType, child.SlotName)) continue;
            var childType = child.RecordType ?? throw new InvalidOperationException(
                $"{child.FormKey} in {key.Name} ({key.Origin}) reached projection untyped, past the read that refuses it.");

            var childBody = _containers.TextOf(child);
            if (string.Equals(childBody, EffectiveBody(key, child.FormKey), StringComparison.Ordinal)) continue;

            touched.Add(child.FormKey);
            if (RowExistsAtEffective(key, child.FormKey))
                ApplyOneWorkingTreeChange(key, child.FormKey, childBody, touched);
            else
                MaterializeRecord(key, child.FormKey, childType, childBody, touched);
        }
    }

    private string? EffectiveBody(PluginAddress key, string formKey) =>
        DuckDbSql.ScalarString(_connection, "SELECT body FROM mirror.records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin);

    // A container's child set and slot order live in its body, so delete-then-insert per parent
    // is correct. A worldspace's exterior cells are not in its body: their own records place them.
    private void RederiveContainmentForRecord(PluginAddress key, string formKey, PluginIngest.PreparedRecord prepared)
    {
        DuckDbSql.ExecuteFor(_connection,
            "DELETE FROM mirror.holdings WHERE parent = $1 AND slot <> $4 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin, HoldingSlots.ExteriorCell);
        if (prepared.Holdings.Count > 0)
        {
            using var appender = _connection.CreateAppender("mirror", "holdings");
            foreach (var row in prepared.Holdings)
                PluginIngest.AppendHoldingRow(appender, row, key.Name, key.Origin);
        }

        foreach (var row in prepared.CellLocations)
        {
            DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.cell_location WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3",
                row.CellFormKey, key.Name, key.Origin);
            using var appender = _connection.CreateAppender("mirror", "cell_location");
            PluginIngest.AppendCellLocationRow(appender, row, key.Name, key.Origin);
        }
    }

    private void DeleteDerivationsForRecord(PluginAddress key, string formKey)
    {
        DeleteFormReferencesForRecord(key, formKey);
        DeleteContainmentForRecord(key, formKey);
    }

    private void DeleteFormReferencesForRecord(PluginAddress key, string formKey) =>
        DuckDbSql.ExecuteFor(_connection,
            "DELETE FROM mirror.form_references WHERE source_form_key = $1 AND source_plugin = $2 AND source_origin = $3",
            formKey, key.Name, key.Origin);

    // Its own facts plus, as a backstop, whatever names it as a parent: DeleteRecord's descendant
    // cascade already gives every descendant its own null-body delta, so a deleted container's
    // children lose their rows via their own deletion.
    private void DeleteContainmentForRecord(PluginAddress key, string formKey)
    {
        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.holdings WHERE (child = $1 OR parent = $1) AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin);
        DuckDbSql.ExecuteFor(_connection, "DELETE FROM mirror.cell_location WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin);
    }
}
