using MEditService.Core.Source;

namespace MEditService.Core.Serialization;

/// <summary>Where a cell sits in the GRUP hierarchy (ADR-0005): the placement fact no document
/// carries, since a worldspace's document omits its blocks. Null blocks beside a worldspace mean
/// its top cell.</summary>
public readonly record struct CellStructure(
    string? ParentWorldspace, int? BlockX, int? BlockY, int? SubX, int? SubY, bool IsInterior);

/// <summary>One placed record a cell's GRUP holds, and which of its two groups (ADR-0005). The
/// parentage no placed record's own document carries.</summary>
public readonly record struct PlacedInCell(string FormKey, string PlacementGroup);

/// <summary>Which container's document carries a record inline, and the slot it sits in: a placed
/// reference in its cell, a response in its topic, a topic in its quest.</summary>
public readonly record struct DocumentContainment(string ParentFormKey, string ParentRecordType, string SlotName);

/// <summary>One record as the text its source file holds (ADR-0007), under the schema table name
/// the index keys it by. A diagnosis makes the text an identity-only stub (ADR-0005 rule 5).</summary>
public sealed record PluginDocument(
    string RecordType,
    string FormKey,
    string Text,
    string? ParseDiagnosis = null,
    CellStructure? Cell = null,
    IReadOnlyList<PlacedInCell>? Contents = null);

/// <summary>A record type whose enumeration could not be finished, so the plugin's rows for it are
/// whatever was reachable before the throw.</summary>
public sealed record RecordTypeFailure(string RecordType, string Diagnosis);

/// <summary>One plugin's records looked up a few at a time rather than streamed: what a copy asks
/// of a source whose tree it cannot read. Owns the open until disposed.</summary>
public interface IPluginRecordLookup : IDisposable
{
    /// <summary>The record type and EditorID the plugin's copy gives <paramref name="formKey"/>,
    /// without serializing the record; null when it holds nothing under that key.</summary>
    RecordIdentity? IdentityOf(string formKey);

    /// <summary>The record's own document, or null when the plugin holds nothing under that
    /// key.</summary>
    string? TextOf(string formKey);

    /// <summary>The container whose own document carries <paramref name="formKey"/> inline, and the
    /// slot it sits in; null when the record has a document of its own.</summary>
    DocumentContainment? ContainmentOf(string formKey);

    /// <summary>Where the GRUP hierarchy puts the cell <paramref name="formKey"/> names (ADR-0005),
    /// or null when the plugin holds no cell under that key.</summary>
    CellStructure? CellStructureOf(string formKey);
}

/// <summary>A plugin's documents, whichever door they came through: the binary through the Plugin
/// adapter, or a tracked plugin's source tree.</summary>
public interface IPluginDocuments : IDisposable
{
    /// <summary>The plugin header's own document — the whole-mod door's root
    /// <c>RecordData.json</c>.</summary>
    PluginDocument Header { get; }

    /// <summary>Streamed: a whole plugin's documents do not fit in memory at once.</summary>
    IEnumerable<PluginDocument> Records { get; }

    /// <summary>Complete once <see cref="Records"/> has been enumerated to the end.</summary>
    IReadOnlyList<RecordTypeFailure> Failures { get; }
}
