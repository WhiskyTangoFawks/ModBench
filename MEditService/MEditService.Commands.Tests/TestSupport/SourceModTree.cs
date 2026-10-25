using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>What a source mod folder's tree holds, read back through the repository the write side
/// wrote through — the whole read model a fixture with no index has.</summary>
internal static class SourceModTree
{
    internal static SourceDocument? Document(string modFolder, PluginAddress plugin, string formKey)
    {
        if (TestAdapters.Source().Open(TestMod.Of(plugin, modFolder), GameRelease.Fallout4) is not { } repository) return null;
        return repository.RecordByFormKey(plugin, formKey).Value();
    }

    /// <summary>The document body for a record a fixture just wrote: absent here is a broken
    /// fixture, not a case under test.</summary>
    internal static string Body(string modFolder, PluginAddress plugin, string formKey) =>
        Document(modFolder, plugin, formKey)?.Body
            ?? throw new InvalidOperationException($"Expected '{formKey}' to have a compiled plugin document in '{modFolder}'.");

    internal static bool IsPartialForm(this SourceDocument document)
    {
        using var json = JsonDocument.Parse(document.Body);
        return json.RootElement.TryGetProperty("MajorRecordFlagsRaw", out var flags)
               && flags.ValueKind == JsonValueKind.Number
               && (flags.GetInt32() & PartialFormFlag.Bit) != 0;
    }

    /// <summary>The FormKeys the tree changed since the last commit, one that has appeared or gone
    /// included.</summary>
    internal static IReadOnlyList<string> ChangedFormKeys(string modFolder, PluginAddress plugin) =>
        [.. Repository(modFolder, plugin)
            .ChangedSinceLastCommit(plugin).Value()
            .Keys.Order(StringComparer.Ordinal)];

    /// <summary>The files holding a record the tree changed since the last commit: an embedded child
    /// answers with its owner's file.</summary>
    internal static IReadOnlyList<string> ChangedDocumentFiles(string modFolder, PluginAddress plugin)
    {
        var repository = Repository(modFolder, plugin);
        return
        [
            .. repository.ChangedSinceLastCommit(plugin).Value()
                .Select(change => DocumentFile(modFolder, plugin, change.Key))
                .OfType<string>().Distinct().Order(StringComparer.Ordinal),
        ];
    }

    /// <summary>The file holding the record: its own document, or its owner's when it is embedded.</summary>
    internal static string? DocumentFile(string modFolder, PluginAddress plugin, string formKey)
    {
        var repository = Repository(modFolder, plugin);
        return repository.RecordByFormKey(plugin, formKey).Value() is { } held
            ? repository.RelativePathOf(plugin, held.Identity).Value()
            : null;
    }

    /// <summary>Every document the plugin's tree holds, as a comparable value: the tree is unchanged
    /// when this is.</summary>
    internal static IReadOnlyList<string> Records(string modFolder, PluginAddress plugin) =>
        [.. TreeDocuments.Of(Repository(modFolder, plugin), plugin).Select(document => $"{document.FormKey} {document.Body}").Order(StringComparer.Ordinal)];

    /// <summary>The one document carrying <paramref name="editorId"/>: a record's own, or the owner's
    /// when the record is embedded in it.</summary>
    internal static SourceDocument DocumentCarrying(string modFolder, PluginAddress plugin, string editorId) =>
        TreeDocuments.Of(Repository(modFolder, plugin), plugin)
            .Single(document => document.Body.Contains($"\"{editorId}\"", StringComparison.Ordinal));

    internal static void Overwrite(string modFolder, PluginAddress plugin, SourceDocument document) =>
        Repository(modFolder, plugin).Put(plugin, document).Wrote();

    /// <summary>Replaces a record's document with <paramref name="body"/>, as another tool leaving
    /// text the codec cannot read would.</summary>
    internal static void Overwrite(string modFolder, PluginAddress plugin, RecordIdentity identity, string body) =>
        Repository(modFolder, plugin).Put(plugin, new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, body)).Wrote();

    /// <summary>A bare npc_ the tree holds under <paramref name="formKey"/>, as a record created there would.</summary>
    internal static void Seed(string modFolder, PluginAddress plugin, string formKey)
    {
        var body = RecordMint.BareDocument(
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["npc_"],
            GameRelease.Fallout4, formKey, editorId: null);
        Repository(modFolder, plugin).Put(plugin, new SourceDocument(formKey, "npc_", null, body)).Wrote();
    }

    internal static uint NextObjectId(string modFolder, PluginAddress plugin) =>
        HeaderDocument.NextObjectId(Encoding.UTF8.GetBytes(
            Document(modFolder, plugin, PluginHeader.IdentityOf(plugin.Name).FormKey).Require().Body), GameRelease.Fallout4);

    internal static string HeaderDocumentFile(string modFolder, PluginAddress plugin) =>
        DocumentFile(modFolder, plugin, PluginHeader.IdentityOf(plugin.Name).FormKey).Require();

    /// <summary>The header's Next Object ID set to <paramref name="nextObjectId"/>, as an edit of the header would.</summary>
    internal static void SetNextObjectId(string modFolder, PluginAddress plugin, uint nextObjectId)
    {
        var repository = Repository(modFolder, plugin);
        var header = repository.RecordOf(plugin, PluginHeader.IdentityOf(plugin.Name)).Value()
            ?? throw new InvalidOperationException($"Expected {plugin.Name}'s tree to hold its header document.");
        var moved = HeaderDocument.WithNextObjectId(Encoding.UTF8.GetBytes(header.Body), GameRelease.Fallout4, nextObjectId);
        repository.Put(plugin, header with { Body = Encoding.UTF8.GetString(moved) }).Wrote();
    }

    internal static void Remove(string modFolder, PluginAddress plugin, RecordIdentity identity) =>
        Repository(modFolder, plugin).Remove(plugin, identity).Wrote();

    /// <summary>Commits the working tree as it stands, so what it holds now is what HEAD holds.
    /// The adapter commits only baselines; a state with more at HEAD is built here.</summary>
    internal static void Commit(string modFolder)
    {
        var gitDirectory = Path.Combine(modFolder, ".git");
        GitProbe.Run(gitDirectory, modFolder, "add", "-A");
        GitProbe.Run(gitDirectory, modFolder, "commit", "-q", "-m", "seed");
    }

    internal static ISourceRepository Repository(string modFolder, PluginAddress plugin) =>
        TestAdapters.Source().Open(TestMod.Of(plugin, modFolder), GameRelease.Fallout4).Require();
}

/// <summary>A fixture whose mod folder holds the source of one plugin: the tree reads below answer for it.</summary>
public interface ICompiledPlugin
{
    string ModFolder { get; }
    PluginAddress Plugin { get; }
}

public static class CompiledPluginTree
{
    public static SourceDocument? Document(this ICompiledPlugin compiledPlugin, string formKey) =>
        SourceModTree.Document(compiledPlugin.ModFolder, compiledPlugin.Plugin, formKey);

    public static SourceDocument DocumentCarrying(this ICompiledPlugin compiledPlugin, string editorId) =>
        SourceModTree.DocumentCarrying(compiledPlugin.ModFolder, compiledPlugin.Plugin, editorId);

    /// <summary>The FormKeys the tree changed since the last commit.</summary>
    public static IReadOnlyList<string> ChangedFormKeys(this ICompiledPlugin compiledPlugin) =>
        SourceModTree.ChangedFormKeys(compiledPlugin.ModFolder, compiledPlugin.Plugin);

    public static IReadOnlyList<string> ChangedDocumentFiles(this ICompiledPlugin compiledPlugin) =>
        SourceModTree.ChangedDocumentFiles(compiledPlugin.ModFolder, compiledPlugin.Plugin);

    public static string? DocumentFile(this ICompiledPlugin compiledPlugin, string formKey) =>
        SourceModTree.DocumentFile(compiledPlugin.ModFolder, compiledPlugin.Plugin, formKey);

    public static uint NextObjectId(this ICompiledPlugin compiledPlugin) => SourceModTree.NextObjectId(compiledPlugin.ModFolder, compiledPlugin.Plugin);

    public static string HeaderDocumentFile(this ICompiledPlugin compiledPlugin) =>
        SourceModTree.HeaderDocumentFile(compiledPlugin.ModFolder, compiledPlugin.Plugin);

    public static void Overwrite(this ICompiledPlugin compiledPlugin, SourceDocument document) =>
        SourceModTree.Overwrite(compiledPlugin.ModFolder, compiledPlugin.Plugin, document);

    public static void Overwrite(this ICompiledPlugin compiledPlugin, RecordIdentity identity, string body) =>
        SourceModTree.Overwrite(compiledPlugin.ModFolder, compiledPlugin.Plugin, identity, body);

    public static void Remove(this ICompiledPlugin compiledPlugin, RecordIdentity identity) =>
        SourceModTree.Remove(compiledPlugin.ModFolder, compiledPlugin.Plugin, identity);
}

/// <summary>A fixture whose plugins sit in several mod folders: the tree reads take the plugin.</summary>
public interface ICompiledPlugins
{
    string ModFolderOf(PluginAddress plugin);
}

public static class CompiledPluginsTree
{
    public static SourceDocument? Document(this ICompiledPlugins compiledPlugin, PluginAddress plugin, string formKey) =>
        SourceModTree.Document(compiledPlugin.ModFolderOf(plugin), plugin, formKey);

    public static SourceDocument? Document(this ICompiledPlugins compiledPlugin, PluginAddress plugin, FormKey formKey) =>
        compiledPlugin.Document(plugin, formKey.ToString());

    public static SourceDocument DocumentCarrying(this ICompiledPlugins compiledPlugin, PluginAddress plugin, string editorId) =>
        SourceModTree.DocumentCarrying(compiledPlugin.ModFolderOf(plugin), plugin, editorId);

    public static uint NextObjectId(this ICompiledPlugins compiledPlugin, PluginAddress plugin) =>
        SourceModTree.NextObjectId(compiledPlugin.ModFolderOf(plugin), plugin);

    public static IReadOnlyList<string> ChangedFormKeys(this ICompiledPlugins compiledPlugin, PluginAddress plugin) =>
        SourceModTree.ChangedFormKeys(compiledPlugin.ModFolderOf(plugin), plugin);

    public static void Overwrite(this ICompiledPlugins compiledPlugin, PluginAddress plugin, SourceDocument document) =>
        SourceModTree.Overwrite(compiledPlugin.ModFolderOf(plugin), plugin, document);
}
