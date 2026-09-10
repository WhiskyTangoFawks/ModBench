namespace MEditService.Core.Serialization;

/// <summary>Where a cell sits in the GRUP hierarchy (ADR-0023): the placement fact no document
/// carries, since a worldspace's document omits its blocks. Null blocks beside a worldspace mean
/// its top cell.</summary>
public readonly record struct CellStructure(
    string? ParentWorldspace, int? BlockX, int? BlockY, int? SubX, int? SubY, bool IsInterior);

/// <summary>One record as the text its source file holds (ADR-0041), under the schema table name
/// the index keys it by. A diagnosis makes the text an identity-only stub (ADR-0032 rule 5).</summary>
public sealed record PluginDocument(
    string RecordType,
    string FormKey,
    string Text,
    string? ParseDiagnosis = null,
    CellStructure? Cell = null);

/// <summary>A record type whose enumeration could not be finished, so the plugin's rows for it are
/// whatever was reachable before the throw.</summary>
public sealed record RecordTypeFailure(string RecordType, string Diagnosis);

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
