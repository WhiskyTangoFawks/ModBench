using MEditService.Core.Plugins;
using MEditService.Core.Queries;

namespace MEditService.Core.Records;

/// <summary>One plugin's copy of one record (ADR-0041). <see cref="Body"/> is exactly the bytes the
/// record's source file holds — for the header, the root <c>RecordData.json</c>.</summary>
public record RecordDocument(
    string FormKey,
    PluginKey Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    string RecordType,
    string? Body,
    IReadOnlyList<FieldValue> Fields,
    bool IsPartialForm = false,
    bool IsPartialFormable = false,
    // Non-null when ingest could not produce this record's own document; the body is then the stub
    // ParseFailedDocument wrote, and no write may land on it.
    string? ParseDiagnosis = null);

/// <summary>For a record with no working-tree change, <see cref="Effective"/> and Head are the same
/// instance (an identity, not merely equal values); for a dirty one, Head is resolved separately
/// from the committed baseline.</summary>
public record OverrideStackEntry(
    PluginKey Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    RecordDocument Effective,
    RecordDocument Head,
    bool HasWorkingTreeChange);

/// <summary>Every plugin's copy of one record, in load order — the "override stack". Named
/// <c>RecordOverrides</c> only because CA1711 rejects a public type name ending in "Stack" that is
/// not a collection.</summary>
public record RecordOverrides(string FormKey, string RecordType, IReadOnlyList<OverrideStackEntry> Entries);

/// <summary>Filters and paging only; a listing's projection and ordering are fixed. Null or empty
/// <c>RecordTypes</c> means every type; <c>Plugin</c> is a filter, not an identity, so a null origin
/// narrows nothing.</summary>
public sealed record RecordQuery(
    IReadOnlyList<string>? RecordTypes = null,
    PluginKey? Plugin = null,
    string? Search = null,
    int Limit = 50,
    int Offset = 0);

/// <summary>One record type's row count for one plugin, from one grouped query.</summary>
public record RecordTypeCount(string Type, int Count, bool HasParseFailure);
