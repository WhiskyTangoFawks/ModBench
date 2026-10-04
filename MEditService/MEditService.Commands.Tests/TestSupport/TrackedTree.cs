using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

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

    /// <summary>What the last commit holds for the record, which a working-tree change does not
    /// alter: its own document, or the owner's when the record is embedded in it.</summary>
    internal static SourceDocument? CommittedDocument(string modFolder, PluginAddress plugin, string formKey)
    {
        var committed = Repository(modFolder).ReadAll(plugin, "HEAD");
        return committed.FirstOrDefault(document => document.FormKey == formKey)
            ?? committed.FirstOrDefault(document => document.Body.Contains($"\"FormKey\": \"{formKey}\"", StringComparison.Ordinal));
    }

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
        var repository = Repository(modFolder);
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

    internal static SourceRepository Repository(string modFolder) =>
        SourceRepository.Open(modFolder, GameRelease.Fallout4).Require();
}

/// <summary>A fixture whose mod folder tracks one plugin: the tree reads below answer for it.</summary>
public interface ITrackedPlugin
{
    string ModFolder { get; }
    PluginAddress Plugin { get; }
}

public static class TrackedPluginTree
{
    public static SourceDocument? Document(this ITrackedPlugin tracked, string formKey) =>
        TrackedTree.Document(tracked.ModFolder, tracked.Plugin, formKey);

    public static SourceDocument? CommittedDocument(this ITrackedPlugin tracked, string formKey) =>
        TrackedTree.CommittedDocument(tracked.ModFolder, tracked.Plugin, formKey);

    public static SourceDocument DocumentCarrying(this ITrackedPlugin tracked, string editorId) =>
        TrackedTree.DocumentCarrying(tracked.ModFolder, tracked.Plugin, editorId);

    /// <summary>The FormKeys whose document differs from the last commit.</summary>
    public static IReadOnlyList<string> ChangedFormKeys(this ITrackedPlugin tracked) =>
        TrackedTree.ChangedFormKeys(tracked.ModFolder, tracked.Plugin);

    public static void Overwrite(this ITrackedPlugin tracked, SourceDocument document) =>
        TrackedTree.Overwrite(tracked.ModFolder, tracked.Plugin, document);

    public static void Overwrite(this ITrackedPlugin tracked, RecordIdentity identity, string body) =>
        TrackedTree.Overwrite(tracked.ModFolder, tracked.Plugin, identity, body);

    public static void Remove(this ITrackedPlugin tracked, RecordIdentity identity) =>
        TrackedTree.Remove(tracked.ModFolder, tracked.Plugin, identity);
}

/// <summary>A fixture whose plugins sit in several mod folders: the tree reads take the plugin.</summary>
public interface ITrackedPlugins
{
    string ModFolderOf(PluginAddress plugin);
}

public static class TrackedPluginsTree
{
    public static SourceDocument? Document(this ITrackedPlugins tracked, PluginAddress plugin, string formKey) =>
        TrackedTree.Document(tracked.ModFolderOf(plugin), plugin, formKey);

    public static SourceDocument? Document(this ITrackedPlugins tracked, PluginAddress plugin, FormKey formKey) =>
        tracked.Document(plugin, formKey.ToString());

    public static SourceDocument DocumentCarrying(this ITrackedPlugins tracked, PluginAddress plugin, string editorId) =>
        TrackedTree.DocumentCarrying(tracked.ModFolderOf(plugin), plugin, editorId);

    public static IReadOnlyList<string> ChangedFormKeys(this ITrackedPlugins tracked, PluginAddress plugin) =>
        TrackedTree.ChangedFormKeys(tracked.ModFolderOf(plugin), plugin);

    public static void Overwrite(this ITrackedPlugins tracked, PluginAddress plugin, SourceDocument document) =>
        TrackedTree.Overwrite(tracked.ModFolderOf(plugin), plugin, document);
}
