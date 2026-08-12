namespace MEditService.Core.Session;

// Participates (#267 / ADR-0035): the plugins.txt `*` prefix — whether this plugin loads in the
// game and competes for winner. An indexed-but-non-participating row can never be a winner and
// never contributes to conflict classification; see DuckDbRecordRepository.UpdateWinners and
// ConflictClassifier.Classify. Implicit masters and freshly created plugins always participate.
//
// Origin (#269 / ADR-0036): the mod folder that provided this physical file, or one of the
// reserved values in PluginOrigin — opaque here, never interpreted. Nothing keys on it yet.
// Defaulted (like Participates) so pre-existing test fixtures that construct a PluginMetadata
// positionally without naming every field keep compiling; every real construction site
// (GameSession.BuildPluginMetadata) always passes it explicitly.
public record PluginMetadata(
    string Name,
    string Path,
    int LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsImmutable,
    string Origin = PluginOrigin.DataDirectory,
    bool Participates = true
);

/// <summary>A plugin that could not be loaded into the session (e.g. an unparseable record);
/// it is skipped so the rest of the load order still loads, and reported here.</summary>
public record PluginLoadFailure(string Name, string Reason);
