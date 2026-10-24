using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>A source mod folder made the Source repository's own way: the binary read as the tree
/// it would commit, committed as the baseline. The Index then reads the tree, never the
/// binary.</summary>
internal static class SourceMods
{
    internal static void Init(string pluginPath, GameRelease release = GameRelease.Fallout4)
    {
        var modFolder = Path.GetDirectoryName(pluginPath)
            ?? throw new ArgumentException("A plugin path names a file inside a mod folder.", nameof(pluginPath));
        var pluginName = Path.GetFileName(pluginPath);
        var read = TestAdapters.Mutagen()
            .ReadSourceOfAsync(
                new RegisteredPlugin(pluginName, PluginOrigin.DataDirectory, pluginPath, PluginProvider.Game, Line: null, HandedStrings.Of(pluginPath)),
                EmptyLoadOrder.Of(release))
            .GetAwaiter().GetResult();
        var source = read.Answered();

        TestAdapters.Source().Init(modFolder, [(source.Files, new DecompiledPlugin(new PluginAddress(pluginName, Path.GetFileName(modFolder)), source.BinarySha256))]);
    }

    internal static void Init(LoadOrderEntry entry, GameRelease release = GameRelease.Fallout4) =>
        Init(entry.Path, release);

    /// <summary>Every plugin of the fixture source mod, so the Index reads each from its tree.</summary>
    internal static ScatteredFixtureData CompiledPlugin(this ScatteredFixtureData fixture)
    {
        foreach (var entry in fixture.Plugins) Init(entry);
        return fixture;
    }

    internal static ISourceRepository RepositoryOf(LoadOrderEntry entry, GameRelease release = GameRelease.Fallout4) =>
        TestAdapters.Source().OverFolder(new PluginProvider.FromMod(entry.Origin, entry.ModFolderOf(), entry.ModFolderOf()), release);

    internal static PluginAddress KeyOf(this LoadOrderEntry entry) => new(entry.Name, entry.Origin);

    internal static string ModFolderOf(this LoadOrderEntry entry) =>
        Path.GetDirectoryName(entry.Path) ?? throw new ArgumentException("A compiled plugin entry sits in a mod folder.", nameof(entry));

    /// <summary>The file the compiled plugin tree keeps <paramref name="identity"/>'s document in, asked of
    /// the repository: an embedded child names its container's file.</summary>
    internal static string SourceFileOf(this LoadOrderEntry entry, RecordIdentity identity, GameRelease release = GameRelease.Fallout4)
    {
        var modFolder = entry.ModFolderOf();
        var relativePath = RepositoryOf(entry, release).RelativePathOf(entry.KeyOf(), identity).Value()
            ?? throw new InvalidOperationException($"No document in {entry.Name}'s tree under '{modFolder}' holds {identity.FormKey}.");
        return Path.Combine(modFolder, relativePath);
    }

    internal static string SourceFileOf(this LoadOrderEntry entry, RecordDetail document) =>
        entry.SourceFileOf(new RecordIdentity(document.FormKey, document.RecordType, document.EditorId));

    /// <summary>The record's own text in the compiled plugin tree: a container's with its children in it, as an
    /// edit starts from.</summary>
    internal static string SourceTextOf(this LoadOrderEntry entry, RecordDetail document) =>
        RepositoryOf(entry).RecordOf(entry.KeyOf(), new RecordIdentity(document.FormKey, document.RecordType, document.EditorId)).Value()?.Body
            ?? throw new InvalidOperationException($"No document in {entry.Name}'s tree holds {document.FormKey}.");

    /// <summary>Git run against the source mod folder: the "other tool" actor, never an
    /// assertion channel.</summary>
    internal static string Git(this LoadOrderEntry entry, params string[] args) =>
        GitProbe.Run(Path.Combine(entry.ModFolderOf(), ".git"), entry.ModFolderOf(), args);

    /// <summary>A hand edit no repository write made: the bytes of a document's own file replaced
    /// behind the Index's back (ADR-0003).</summary>
    internal static void HandEdit(this LoadOrderEntry entry, RecordDetail document, string from, string to)
    {
        var path = entry.SourceFileOf(document);
        File.WriteAllText(path, File.ReadAllText(path).Replace(from, to, StringComparison.Ordinal));
    }

    /// <summary>A hand rename of a document's EditorID that also renames its file, as the layout names it,
    /// so the file stays where it belongs.</summary>
    internal static void RenameByHand(this LoadOrderEntry entry, RecordDetail document, string editorId)
    {
        var path = entry.SourceFileOf(document);
        var renamed = Path.Combine(
            Path.GetDirectoryName(path).Require(),
            Path.GetFileName(path).Replace($"{document.EditorId} - ", $"{editorId} - ", StringComparison.Ordinal));
        File.Move(path, renamed);
        File.WriteAllText(renamed, File.ReadAllText(renamed).Replace($"\"{document.EditorId}\"", $"\"{editorId}\"", StringComparison.Ordinal));
    }

    /// <summary>The working tree's copy of <paramref name="document"/> replaced by
    /// <paramref name="body"/>, then the next snapshot.</summary>
    internal static void Edit(this OpenedIndex index, LoadOrderEntry entry, RecordDetail document, string body)
    {
        RepositoryOf(entry).Put(entry.KeyOf(), new SourceDocument(document.FormKey, document.RecordType, document.EditorId, body)).Wrote();
        index.NextSnapshot();
    }

    /// <summary>The working tree's copy of <paramref name="document"/> put under
    /// <paramref name="newEditorId"/>, which moves it to the name that computes, then the next snapshot.</summary>
    internal static void Rename(
        this OpenedIndex index, LoadOrderEntry entry, RecordDetail document, string newEditorId, string body)
    {
        RepositoryOf(entry).Put(
            entry.KeyOf(), new SourceDocument(document.FormKey, document.RecordType, newEditorId, body)).Wrote();
        index.NextSnapshot();
    }

    /// <summary>The working tree's copy of <paramref name="document"/> put under <paramref name="newEditorId"/>, written from
    /// <see cref="SourceTextOf"/> so a container keeps the children it embeds.</summary>
    internal static void RenameEditorId(this OpenedIndex index, LoadOrderEntry entry, RecordDetail document, string newEditorId) =>
        index.Rename(
            entry, document, newEditorId,
            entry.SourceTextOf(document).Replace($"\"{document.EditorId}\"", $"\"{newEditorId}\"", StringComparison.Ordinal));

    /// <summary>A document the working tree gains, then the next snapshot.</summary>
    internal static void Create(this OpenedIndex index, LoadOrderEntry entry, string formKey, string recordType, string? editorId, string body)
    {
        RepositoryOf(entry).Put(entry.KeyOf(), new SourceDocument(formKey, recordType, editorId, body)).Wrote();
        index.NextSnapshot();
    }

    /// <summary>Several working-tree changes made the Source repository's own way, then the next
    /// snapshot's one validation (ADR-0003). A null body is the document taken out.</summary>
    internal static void Project(
        this OpenedIndex index, LoadOrderEntry entry, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        var repository = RepositoryOf(entry);
        foreach (var (formKey, body) in deltas)
        {
            var current = index.DocumentOf(formKey, entry.KeyOf());
            if (body is null)
                repository.Remove(entry.KeyOf(), new RecordIdentity(formKey, current.RecordType, current.EditorId)).Wrote();
            else
                repository.Put(entry.KeyOf(), new SourceDocument(formKey, current.RecordType, current.EditorId, body)).Wrote();
        }
        index.NextSnapshot();
    }

    /// <summary>The working tree's copy of <paramref name="document"/> taken out, then the next
    /// snapshot.</summary>
    internal static void Delete(this OpenedIndex index, LoadOrderEntry entry, RecordDetail document)
    {
        RepositoryOf(entry).Remove(entry.KeyOf(), new RecordIdentity(document.FormKey, document.RecordType, document.EditorId)).Wrote();
        index.NextSnapshot();
    }
}
