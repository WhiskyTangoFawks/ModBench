using System.Text.Json;
using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.TestSupport;

/// <summary>What a tracked mod folder's tree holds, read back through the repository the write side
/// wrote through — the whole read model a fixture with no index has.</summary>
internal static class TrackedTree
{
    internal static SourceDocument? Document(string modFolder, PluginKey plugin, string formKey)
    {
        if (SourceRepository.Open(modFolder, GameRelease.Fallout4) is not { } repository) return null;
        var identity = repository.IdentityOf(
            plugin, formKey, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4));
        return identity is { } held ? repository.Get(plugin, held) : null;
    }

    /// <summary>The same question at a named ref: what the last commit holds, which a working-tree
    /// change does not alter.</summary>
    internal static SourceDocument? CommittedDocument(
        string modFolder, PluginKey plugin, RecordIdentity identity) =>
        SourceRepository.Open(modFolder, GameRelease.Fallout4)?.GetAt(plugin, identity, "HEAD");

    internal static bool IsPartialForm(this SourceDocument document)
    {
        using var json = JsonDocument.Parse(document.Body);
        return json.RootElement.TryGetProperty("MajorRecordFlagsRaw", out var flags)
               && flags.ValueKind == JsonValueKind.Number
               && (flags.GetInt32() & PartialFormFlag.Bit) != 0;
    }

    internal static IReadOnlyList<string> GitStatus(string modFolder) =>
        GitCli.Run(Path.Combine(modFolder, ".git"), modFolder, "status", "--porcelain")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim())
            .ToList();
}
