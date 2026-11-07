using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Store;

/// <summary>The working-tree overlay collaborator of <see cref="Store"/>, which owns
/// every transaction and the winner sweep. Uses <c>PluginIngest</c>'s collectors so an edit's
/// derived rows cannot drift from ingest's.</summary>
internal sealed class WorkingTreeOverlay
{
    private const string AmongKeys = "IN (SELECT unnest($3::VARCHAR[]))";

    private readonly DuckDBConnection _connection;
    private readonly ILogger _logger;
    private readonly ContainerDocuments _containers;
    private readonly PluginIngest _ingest;
    private readonly Func<string, string> _contentStamp;
    private readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas;
    private readonly RecordTypes _types;
    private readonly GameRelease _release;

    public WorkingTreeOverlay(
        DuckDBConnection connection, ILogger logger, IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release,
        Func<string, string> contentStamp)
    {
        _contentStamp = contentStamp;
        _connection = connection;
        _logger = logger;
        _containers = new ContainerDocuments(release);
        _ingest = new PluginIngest(connection, logger, release, contentStamp);
        _types = RecordTypes.For(release);
        _release = release;
        _schemas = schemas;
    }

    private sealed record Written(string FormKey, string RecordType, string Body, bool Held);

    // Prepared is null for a type with no schema, and for the header, which carries no reference graph and cannot go
    // through the per-record codec.
    private sealed record Derived(
        Written Document, string StoredBody, string Stamp, bool HasSchema, PluginIngest.PreparedRecord? Prepared,
        List<ContainerDocuments.ChildDocument> Embedded);

    /// <summary>Folds re-derived documents into the read model: null Body deletes, byte-equal body
    /// converges. Returns every key whose rows moved.</summary>
    public List<string> ProjectDocuments(PluginAddress key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        // The deltas' own keys are named whether or not their bytes moved: the caller asked about
        // them, and a subscriber re-reading one it was told about costs one query.
        var movedKeys = new List<string>(deltas.Select(d => d.FormKey));
        var held = RecordTypesHeld(key, movedKeys);

        List<Written> written = [];
        List<string> gone = [];
        foreach (var (formKey, body) in deltas)
        {
            if (held.TryGetValue(formKey, out var recordType))
            {
                if (body == null) gone.Add(formKey);
                else written.Add(new Written(formKey, recordType, body, Held: true));
            }
            // A create is its own gesture and there is nothing here to derive its record_type from, so
            // this is a caller mistake: logged, skipped, never thrown (the seam's missing-data rule).
            else if (body != null)
            {
                _logger.LogWarning(
                    "Ignoring a working-tree change for {FormKey}, which {Plugin} ({Origin}) does not hold",
                    formKey, key.Name, key.Origin);
            }
        }

        var uncarried = Write(key, written, movedKeys);
        Remove(key, gone, uncarried, movedKeys);
        return [.. movedKeys.Distinct(StringComparer.Ordinal)];
    }

    private Dictionary<string, string> RecordTypesHeld(PluginAddress key, List<string> formKeys) =>
        DuckDbSql.Rows(
                _connection, $"SELECT form_key, record_type FROM mirror.records WHERE plugin = $1 AND origin = $2 AND form_key {AmongKeys}",
                reader => (FormKey: reader.GetString(0), RecordType: reader.GetString(1)),
                key.Name, key.Origin, formKeys)
            .ToDictionary(row => row.FormKey, row => row.RecordType, StringComparer.Ordinal);

    private List<string> Write(PluginAddress key, List<Written> documents, List<string> movedKeys)
    {
        List<string> uncarried = [];
        while (documents.Count > 0)
        {
            // Two documents carrying one FormKey is a disk state ADR-0006 diagnoses (OneDocumentPerFormKey).
            var level = documents.GroupBy(d => d.FormKey, StringComparer.Ordinal).Select(g => g.Last()).ToList();
            var derived = PluginIngest.InParallel(level, d => Derive(key, d));
            var containers = derived.Where(d => d.Prepared != null).ToList();
            var recordedBefore = EmbeddedChildrenRecorded(key, containers);

            WriteRecords(key, derived);
            ReplaceReferences(key, [.. derived.Where(d => d.HasSchema)]);
            ReplaceContainment(key, [.. containers.Select(d => d.Prepared).OfType<PluginIngest.PreparedRecord>()]);

            foreach (var container in containers)
            {
                var carried = container.Embedded.Select(c => c.FormKey).ToHashSet(StringComparer.Ordinal);
                uncarried.AddRange(recordedBefore[container.Document.FormKey].Where(child => !carried.Contains(child)));
            }
            documents = EmbeddedChildrenMoved(key, [.. derived.SelectMany(d => d.Embedded)]);
            movedKeys.AddRange(documents.Select(d => d.FormKey));
        }
        return uncarried;
    }

    // Rebuilt through the same collectors ingest uses, so an edit cannot leave derived answers describing bytes that are gone.
    private Derived Derive(PluginAddress key, Written document)
    {
        if (!_schemas.TryGetValue(document.RecordType, out var schema) || document.RecordType == PluginHeader.RecordType)
        {
            return new Derived(
                document, ContainerDocumentEdits.WithChildSlotsCut(document.Body, document.RecordType, _release), _contentStamp(document.Body),
                HasSchema: schema != null, Prepared: null, []);
        }

        List<ContainerDocuments.ChildDocument> children = [];
        var prepared = _ingest.PrepareRecord(new PluginDocument(document.RecordType, document.FormKey, document.Body), key.Name, schema, children);
        return new Derived(
            document, prepared.Body, prepared.ContentHash, HasSchema: true, prepared,
            [.. children.Where(c => _types.IsEmbeddedSlot(document.RecordType, c.SlotName))]);
    }

    // Only the children a container's document carries: a worldspace's exterior cells are placed by their own records.
    private Dictionary<string, List<string>> EmbeddedChildrenRecorded(PluginAddress key, List<Derived> containers)
    {
        var recorded = containers.ToDictionary(d => d.Document.FormKey, _ => new List<string>(), StringComparer.Ordinal);
        var typeOf = containers.ToDictionary(d => d.Document.FormKey, d => d.Document.RecordType, StringComparer.Ordinal);
        foreach (var (parent, child, slot) in HoldingsUnder(key, [.. typeOf.Keys]))
        {
            if (_types.IsEmbeddedSlot(typeOf[parent], slot)) recorded[parent].Add(child);
        }
        return recorded;
    }

    private List<(string Parent, string Child, string Slot)> HoldingsUnder(PluginAddress key, List<string> parents) =>
        DuckDbSql.Rows(
            _connection, $"SELECT parent, child, slot FROM mirror.holdings WHERE plugin = $1 AND origin = $2 AND parent {AmongKeys}",
            reader => (reader.GetString(0), reader.GetString(1), reader.GetString(2)),
            key.Name, key.Origin, parents);

    // editor_id follows the body, or a renamed record would keep listing under its old EditorID. A held row keeps its
    // record_type, since a record cannot change type, and its masters where nothing re-derived them.
    private void WriteRecords(PluginAddress key, List<Derived> derived)
    {
        var held = derived.Where(d => d.Document.Held).ToList();
        if (held.Count > 0)
        {
            DuckDbSql.Execute(_connection, """
                UPDATE mirror.records r
                SET body = m.body, content_hash = m.content_hash, editor_id = json_extract_string(m.body, '$.EditorID'),
                    masters = coalesce(m.masters, r.masters)
                FROM (SELECT unnest($3::VARCHAR[]) AS form_key, unnest($4::VARCHAR[]) AS body,
                             unnest($5::VARCHAR[]) AS content_hash, unnest($6::VARCHAR[][]) AS masters) m
                WHERE r.form_key = m.form_key AND r.plugin = $1 AND r.origin = $2
                """, key.Name, key.Origin, Column(held, d => d.Document.FormKey), Column(held, d => d.StoredBody),
                Column(held, d => d.Stamp), Column(held, d => d.Prepared?.Masters));
        }

        var materialized = derived.Where(d => !d.Document.Held).ToList();
        if (materialized.Count == 0) return;

        // ADR-0012: no load_order_idx to carry into the row; this check only refuses a
        // plugin the registration doesn't know.
        if (!IsRegisteredPlugin(key))
            throw new InvalidOperationException($"{key.Name} ({key.Origin}) is not an indexed plugin.");
        DuckDbSql.Execute(_connection, """
            INSERT INTO mirror.records (form_key, plugin, origin, record_type, editor_id, body, content_hash, masters, form_key_plugin)
            SELECT form_key, $1, $2, record_type, json_extract_string(body, '$.EditorID'), body, content_hash, coalesce(masters, []), form_key_plugin
            FROM (SELECT unnest($3::VARCHAR[]) AS form_key, unnest($4::VARCHAR[]) AS record_type, unnest($5::VARCHAR[]) AS body,
                         unnest($6::VARCHAR[]) AS content_hash, unnest($7::VARCHAR[][]) AS masters, unnest($8::VARCHAR[]) AS form_key_plugin)
            """, key.Name, key.Origin, Column(materialized, d => d.Document.FormKey), Column(materialized, d => d.Document.RecordType),
            Column(materialized, d => d.StoredBody), Column(materialized, d => d.Stamp), Column(materialized, d => d.Prepared?.Masters),
            Column(materialized, d => RecordMasters.PluginNamedBy(d.Document.FormKey)));
    }

    private static List<T> Column<T>(List<Derived> rows, Func<Derived, T> value) => [.. rows.Select(value)];

    private bool IsRegisteredPlugin(PluginAddress key) =>
        DuckDbSql.ScalarString(_connection,
            $"SELECT plugin FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = $1 AND origin = $2", key.Name, key.Origin) != null;

    private void ReplaceReferences(PluginAddress key, List<Derived> derived)
    {
        DeleteReferencesFrom(key, [.. derived.Select(d => d.Document.FormKey)]);
        using var appender = _connection.CreateAppender(TableDdlBuilder.MirrorSchema, "form_references");
        foreach (var reference in derived.SelectMany(d => d.Prepared?.Refs ?? []))
            PluginIngest.AppendFormReference(appender, reference, key.Name, key.Origin);
    }

    // A container's child set and slot order live in its document, so delete-then-insert per parent
    // is correct. A worldspace's exterior cells are not in its document: their own records place them.
    private void ReplaceContainment(PluginAddress key, List<PluginIngest.PreparedRecord> prepared)
    {
        DuckDbSql.Execute(_connection,
            $"DELETE FROM mirror.holdings WHERE plugin = $1 AND origin = $2 AND slot <> {HoldingSlots.Exterior} AND parent {AmongKeys}",
            key.Name, key.Origin, prepared.Select(p => p.FormKey).ToList());
        using (var appender = _connection.CreateAppender(TableDdlBuilder.MirrorSchema, "holdings"))
        {
            foreach (var row in prepared.SelectMany(p => p.Holdings))
                PluginIngest.AppendHoldingRow(appender, row, key.Name, key.Origin);
        }

        var cellLocations = prepared.SelectMany(p => p.CellLocations).ToList();
        DeleteCellLocationsOf(key, [.. cellLocations.Select(row => row.CellFormKey)]);
        using (var appender = _connection.CreateAppender(TableDdlBuilder.MirrorSchema, "cell_location"))
        {
            foreach (var row in cellLocations)
                PluginIngest.AppendCellLocationRow(appender, row, key.Name, key.Origin);
        }
    }

    // An embedded child's own row is a projection of its container's document, serialized out of the container's
    // graph through the codec ingest uses.
    private List<Written> EmbeddedChildrenMoved(PluginAddress key, List<ContainerDocuments.ChildDocument> children)
    {
        if (children.Count == 0) return [];
        var stored = DuckDbSql.Rows(
                _connection,
                $"SELECT form_key, record_type, content_hash FROM mirror.records WHERE plugin = $1 AND origin = $2 AND form_key {AmongKeys}",
                reader => (FormKey: reader.GetString(0), RecordType: reader.GetString(1), Stamp: reader.GetString(2)),
                key.Name, key.Origin, children.Select(child => child.FormKey).ToList())
            .ToDictionary(row => row.FormKey, StringComparer.Ordinal);
        return [.. PluginIngest.InParallel(children, child =>
            {
                var childType = child.RecordType ?? throw new InvalidOperationException(
                    $"{child.FormKey} in {key.Name} ({key.Origin}) reached projection untyped, past the read that refuses it.");
                var body = _containers.TextOf(child);
                if (!stored.TryGetValue(child.FormKey, out var row)) return new Written(child.FormKey, childType, body, Held: false);
                return string.Equals(_contentStamp(body), row.Stamp, StringComparison.Ordinal)
                    ? null
                    : new Written(child.FormKey, row.RecordType, body, Held: true);
            }).OfType<Written>()];
    }

    private void Remove(PluginAddress key, List<string> gone, List<string> maybeGone, List<string> movedKeys)
    {
        while (gone.Count + maybeGone.Count > 0)
        {
            var unheld = Unheld(key, maybeGone);
            movedKeys.AddRange(unheld);
            List<string> level = [.. gone, .. unheld];
            maybeGone = [.. HoldingsUnder(key, level).Select(row => row.Child)];
            gone = [];

            // Document and derived rows alike: dropping only the document would leave the record in the reference graph.
            DuckDbSql.Execute(_connection, $"DELETE FROM mirror.records WHERE plugin = $1 AND origin = $2 AND form_key {AmongKeys}",
                key.Name, key.Origin, level);
            DeleteReferencesFrom(key, level);
            DuckDbSql.Execute(_connection,
                $"DELETE FROM mirror.holdings WHERE plugin = $1 AND origin = $2 AND (child {AmongKeys} OR parent {AmongKeys})",
                key.Name, key.Origin, level);
            DeleteCellLocationsOf(key, level);
        }
    }

    private List<string> Unheld(PluginAddress key, List<string> formKeys) =>
        formKeys.Count == 0
            ? []
            : DuckDbSql.Rows(
                _connection, $"""
                SELECT form_key FROM mirror.records
                WHERE plugin = $1 AND origin = $2 AND form_key {AmongKeys}
                  AND form_key NOT IN (SELECT child FROM mirror.holdings WHERE plugin = $1 AND origin = $2 AND child {AmongKeys})
                """,
                reader => reader.GetString(0), key.Name, key.Origin, formKeys);

    private void DeleteReferencesFrom(PluginAddress key, List<string> formKeys) =>
        DuckDbSql.Execute(_connection,
            $"DELETE FROM mirror.form_references WHERE source_plugin = $1 AND source_origin = $2 AND source_form_key {AmongKeys}",
            key.Name, key.Origin, formKeys);

    private void DeleteCellLocationsOf(PluginAddress key, List<string> formKeys) =>
        DuckDbSql.Execute(_connection,
            $"DELETE FROM mirror.cell_location WHERE plugin = $1 AND origin = $2 AND cell_form_key {AmongKeys}",
            key.Name, key.Origin, formKeys);
}
