using MEditService.Codec.Serialization;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>A tracked mod folder made the Source repository's own way: the binary read as the tree
/// it would commit, committed as the baseline. The Index then reads the tree, never the
/// binary.</summary>
internal static class TrackedMods
{
    internal static void Track(string pluginPath, string dataFolder, GameRelease release = GameRelease.Fallout4)
    {
        var modFolder = Path.GetDirectoryName(pluginPath)
            ?? throw new ArgumentException("A plugin path names a file inside a mod folder.", nameof(pluginPath));
        var pluginName = Path.GetFileName(pluginPath);
        var (files, missingStrings) = TestAdapters.Mutagen()
            .ReadSourceOfAsync(
                new RegisteredPlugin(pluginName, PluginOrigin.DataDirectory, pluginPath, PluginProvider.Game, Line: null), release,
                new PluginStrings(modFolder, dataFolder))
            .GetAwaiter().GetResult();
        if (missingStrings is not null)
            throw new InvalidOperationException($"{pluginName} declares strings file '{missingStrings}' and the disk has none.");

        SourceRepository.Track(
            modFolder,
            [(SourceRepository.PristineFilesOf(pluginName, files),
              new DecompiledPlugin(pluginName, PluginBinaryHash.TrailerFormOfFile(pluginPath)))]);
    }

    internal static void Track(LoadOrderEntry entry, string dataFolder, GameRelease release = GameRelease.Fallout4) =>
        Track(entry.Path, dataFolder, release);

    /// <summary>Every plugin of the fixture tracked, so the Index reads each from its tree.</summary>
    internal static ScatteredFixtureData Tracked(this ScatteredFixtureData fixture)
    {
        foreach (var entry in fixture.Plugins) Track(entry, fixture.GameDirectory);
        return fixture;
    }

    internal static SourceRepository RepositoryOf(LoadOrderEntry entry, GameRelease release = GameRelease.Fallout4) =>
        SourceRepository.Over(new PluginProvider.FromMod(entry.Origin, entry.ModFolderOf()), release);

    internal static PluginAddress KeyOf(this LoadOrderEntry entry) => new(entry.Name, entry.Origin);

    internal static string ModFolderOf(this LoadOrderEntry entry) =>
        Path.GetDirectoryName(entry.Path) ?? throw new ArgumentException("A tracked entry sits in a mod folder.", nameof(entry));

    /// <summary>The file the tracked tree keeps <paramref name="identity"/>'s document in, asked of
    /// the repository: an embedded child names its container's file.</summary>
    internal static string SourceFileOf(this LoadOrderEntry entry, RecordIdentity identity, GameRelease release = GameRelease.Fallout4)
    {
        var modFolder = entry.ModFolderOf();
        var relativePath = RepositoryOf(entry, release).RelativePathOf(entry.KeyOf(), identity)
            ?? throw new InvalidOperationException($"No document in {entry.Name}'s tree under '{modFolder}' holds {identity.FormKey}.");
        return Path.Combine(modFolder, relativePath);
    }

    internal static string SourceFileOf(this LoadOrderEntry entry, RecordDetail document) =>
        entry.SourceFileOf(new RecordIdentity(document.FormKey, document.RecordType, document.EditorId));

    /// <summary>Git run against the tracked mod folder: the "other tool" actor, never an
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

    /// <summary>The working tree's copy of <paramref name="document"/> replaced by
    /// <paramref name="body"/>, then the next snapshot.</summary>
    internal static void Edit(this OpenedIndex index, LoadOrderEntry entry, RecordDetail document, string body)
    {
        RepositoryOf(entry).Put(entry.KeyOf(), new SourceDocument(document.FormKey, document.RecordType, document.EditorId, body));
        index.NextSnapshot();
    }

    /// <summary>The working tree's copy of <paramref name="document"/> put under
    /// <paramref name="newEditorId"/>, which moves it to the name that computes, then the next snapshot.</summary>
    internal static void Rename(
        this OpenedIndex index, LoadOrderEntry entry, RecordDetail document, string newEditorId, string body)
    {
        RepositoryOf(entry).Put(
            entry.KeyOf(), new SourceDocument(document.FormKey, document.RecordType, newEditorId, body));
        index.NextSnapshot();
    }

    /// <summary>A document the working tree gains, then the next snapshot.</summary>
    internal static void Create(this OpenedIndex index, LoadOrderEntry entry, string formKey, string recordType, string? editorId, string body)
    {
        RepositoryOf(entry).Put(entry.KeyOf(), new SourceDocument(formKey, recordType, editorId, body));
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
                repository.Remove(entry.KeyOf(), new RecordIdentity(formKey, current.RecordType, current.EditorId));
            else
                repository.Put(entry.KeyOf(), new SourceDocument(formKey, current.RecordType, current.EditorId, body));
        }
        index.NextSnapshot();
    }

    /// <summary>The working tree's copy of <paramref name="document"/> taken out, then the next
    /// snapshot.</summary>
    internal static void Delete(this OpenedIndex index, LoadOrderEntry entry, RecordDetail document)
    {
        var removed = RepositoryOf(entry).Remove(
            entry.KeyOf(), new RecordIdentity(document.FormKey, document.RecordType, document.EditorId));
        if (removed != SourceRemoval.Removed)
            throw new InvalidOperationException($"The tree did not give up '{document.FormKey}': {removed}.");
        index.NextSnapshot();
    }
}
