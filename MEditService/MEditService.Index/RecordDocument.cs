using MEditService.Codec.Schema;
using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>One plugin's copy of one record. <see cref="Body"/> is the document the index stores (ADR-0005):
/// for the header, the root <c>RecordData.json</c>.</summary>
internal sealed record RecordDocument(
    string FormKey,
    PluginAddress Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    string RecordType,
    string? Body,
    IReadOnlyList<FieldValue> Fields,
    bool IsPartialForm = false,
    // Non-null when ingest could not produce this record's own document; the body is then the stub
    // ParseFailedDocument wrote, and no write may land on it.
    string? ParseDiagnosis = null);

internal sealed record OverrideStackEntry(
    PluginAddress Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    RecordDocument Effective,
    bool HasWorkingTreeChange);

/// <summary>Every plugin's copy of one record, in load order.</summary>
internal sealed record OverrideStack(string FormKey, string RecordType, IReadOnlyList<OverrideStackEntry> Entries);

/// <summary><c>GroupOnly</c> lists a group in FormID order, otherwise by EditorID.
/// <c>SearchFormKey</c> is a FormID search's FormKey, matched beside the EditorID text.
/// <c>Plugin</c> and <c>Origin</c> filter apart (ADR-0012).</summary>
internal sealed record RecordQuery(
    RecordQueryScope Scope,
    IReadOnlyList<string>? RecordTypes = null,
    PluginName? Plugin = null,
    string? Origin = null,
    string? Search = null,
    string? SearchFormKey = null,
    int Limit = 50,
    int Offset = 0,
    bool GroupOnly = false);

/// <summary>The record filter narrows the navigator and never a search: plugins.md says of it, "It never
/// narrows the Editor or Referenced By".</summary>
internal enum RecordQueryScope { Navigator, Search }

/// <summary>One record type's row count for one plugin, from one grouped query.</summary>
internal sealed record RecordTypeCount(string Type, int Count, bool HasParseFailure);
