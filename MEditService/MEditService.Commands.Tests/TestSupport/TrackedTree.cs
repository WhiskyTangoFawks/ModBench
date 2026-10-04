using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>What a tracked mod folder's tree holds, read back through the repository the write side
/// wrote through — the whole read model a fixture with no index has.</summary>
internal static class TrackedTree
{
    internal static SourceDocument? Document(string modFolder, PluginAddress plugin, string formKey)
    {
        if (SourceRepository.Open(modFolder, GameRelease.Fallout4) is not { } repository) return null;
        var identity = repository.IdentityOf(
            plugin, formKey, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4));
        return identity is { } held ? repository.Get(plugin, held) : null;
    }

    /// <summary>The document body for a record a fixture just wrote: absent here is a broken
    /// fixture, not a case under test.</summary>
    internal static string Body(string modFolder, PluginAddress plugin, string formKey) =>
        Document(modFolder, plugin, formKey)?.Body
            ?? throw new InvalidOperationException($"Expected '{formKey}' to have a tracked document in '{modFolder}'.");

    /// <summary>The same question at a named ref: what the last commit holds, which a working-tree
    /// change does not alter.</summary>
    internal static SourceDocument? CommittedDocument(
        string modFolder, PluginAddress plugin, RecordIdentity identity) =>
        SourceRepository.Open(modFolder, GameRelease.Fallout4)?.GetAt(plugin, identity, "HEAD");

    internal static bool IsPartialForm(this SourceDocument document)
    {
        using var json = JsonDocument.Parse(document.Body);
        return json.RootElement.TryGetProperty("MajorRecordFlagsRaw", out var flags)
               && flags.ValueKind == JsonValueKind.Number
               && (flags.GetInt32() & PartialFormFlag.Bit) != 0;
    }

    /// <summary>The FormKeys whose document differs between the last commit and the working tree,
    /// one that has appeared or gone included.</summary>
    internal static IReadOnlyList<string> ChangedFormKeys(string modFolder, PluginAddress plugin)
    {
        var repository = SourceRepository.Open(modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{modFolder}' to already be tracked.");
        var committed = repository.ReadAll(plugin, "HEAD").ToDictionary(document => document.FormKey, document => document.Body);
        var working = repository.ReadAll(plugin).ToDictionary(document => document.FormKey, document => document.Body);
        return
        [
            .. committed.Keys.Union(working.Keys)
                .Where(formKey => !committed.TryGetValue(formKey, out var was) || !working.TryGetValue(formKey, out var now) || was != now)
                .Order(StringComparer.Ordinal),
        ];
    }

    /// <summary>Every document the plugin's tree holds, as a comparable value: the tree is unchanged
    /// when this is.</summary>
    internal static IReadOnlyList<string> Records(string modFolder, PluginAddress plugin) =>
        [.. Repository(modFolder).ReadAll(plugin).Select(document => $"{document.FormKey} {document.Body}").Order(StringComparer.Ordinal)];

    /// <summary>The one document carrying <paramref name="editorId"/>: a record's own, or the owner's
    /// when the record is embedded in it.</summary>
    internal static SourceDocument DocumentCarrying(string modFolder, PluginAddress plugin, string editorId) =>
        Repository(modFolder).ReadAll(plugin)
            .Single(document => document.Body.Contains($"\"{editorId}\"", StringComparison.Ordinal));

    internal static void Overwrite(string modFolder, PluginAddress plugin, SourceDocument document) =>
        Repository(modFolder).Put(plugin, document);

    /// <summary>Replaces a record's document with <paramref name="body"/>, as another tool leaving
    /// text the codec cannot read would.</summary>
    internal static void Overwrite(string modFolder, PluginAddress plugin, RecordIdentity identity, string body) =>
        Repository(modFolder).Put(plugin, new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, body));

    internal static void Remove(string modFolder, PluginAddress plugin, RecordIdentity identity) =>
        Repository(modFolder).Remove(plugin, identity);

    /// <summary>Commits the working tree as it stands, so what it holds now is what HEAD holds.
    /// The adapter commits only baselines; a state with more at HEAD is built here.</summary>
    internal static void Commit(string modFolder)
    {
        var gitDirectory = Path.Combine(modFolder, ".git");
        GitProbe.Run(gitDirectory, modFolder, "add", "-A");
        GitProbe.Run(gitDirectory, modFolder, "commit", "-q", "-m", "seed");
    }

    private static SourceRepository Repository(string modFolder) =>
        SourceRepository.Open(modFolder, GameRelease.Fallout4)
        ?? throw new InvalidOperationException($"Expected '{modFolder}' to already be tracked.");
}
