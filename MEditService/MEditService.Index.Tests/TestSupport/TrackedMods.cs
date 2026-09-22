using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

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
        var modPath = new ModPath(ModKey.FromFileName(pluginName), pluginPath);
        var (files, missingStrings) = TestAdapters.Mutagen()
            .ReadSourceAsync(modPath, pluginName, release, new PluginStrings(modFolder, dataFolder))
            .GetAwaiter().GetResult();
        if (missingStrings is not null)
            throw new InvalidOperationException($"{pluginName} declares strings file '{missingStrings}' and the disk has none.");

        var trailers = new TrackProvenance(
            null, null, new Dictionary<string, string> { [pluginName] = PluginBinaryHash.TrailerFormOfFile(pluginPath) });
        SourceRepository.Track(modFolder, SourcePreset.Edits, SourceRepository.PristineFilesOf(pluginName, files), trailers);
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
        SourceRepository.Over(
            Path.GetDirectoryName(entry.Path) ?? throw new ArgumentException("A tracked entry sits in a mod folder.", nameof(entry)),
            release);

    internal static PluginCopyKey KeyOf(this LoadOrderEntry entry) => new(entry.Name, entry.Origin);

    internal static string ModFolderOf(this LoadOrderEntry entry) =>
        Path.GetDirectoryName(entry.Path) ?? throw new ArgumentException("A tracked entry sits in a mod folder.", nameof(entry));

    /// <summary>The file the tracked tree keeps <paramref name="identity"/>'s document in, asked of
    /// the repository: an embedded child names its container's file.</summary>
    internal static string SourceFileOf(this LoadOrderEntry entry, RecordIdentity identity, GameRelease release = GameRelease.Fallout4)
    {
        var modFolder = entry.ModFolderOf();
        var unit = RepositoryOf(entry, release).UnitHolding(entry.KeyOf(), identity)
            ?? throw new InvalidOperationException($"No document in {entry.Name}'s tree under '{modFolder}' holds {identity.FormKey}.");
        return Path.Combine(modFolder, unit.RelativePath);
    }

    internal static string SourceFileOf(this LoadOrderEntry entry, RecordDocument document) =>
        entry.SourceFileOf(new RecordIdentity(document.FormKey, document.RecordType, document.EditorId));

    /// <summary>Git run against the tracked mod folder: the "other tool" actor, never an
    /// assertion channel.</summary>
    internal static string Git(this LoadOrderEntry entry, params string[] args) =>
        GitProbe.Run(Path.Combine(entry.ModFolderOf(), ".git"), entry.ModFolderOf(), args);

    /// <summary>A hand edit no repository write made: the bytes of a document's own file replaced
    /// behind the Index's back (ADR-0003).</summary>
    internal static void HandEdit(this LoadOrderEntry entry, RecordDocument document, string from, string to)
    {
        var path = entry.SourceFileOf(document);
        File.WriteAllText(path, File.ReadAllText(path).Replace(from, to, StringComparison.Ordinal));
    }

    /// <summary>The working tree's copy of <paramref name="document"/> replaced by
    /// <paramref name="body"/>, then the narrow signal a Source watcher would send.</summary>
    internal static void Edit(this IndexProjector index, LoadOrderEntry entry, RecordDocument document, string body)
    {
        RepositoryOf(entry).Put(entry.KeyOf(), new SourceDocument(document.FormKey, document.RecordType, document.EditorId, body));
        index.RefreshKeys(entry.KeyOf(), [document.FormKey]);
    }

    /// <summary>The working tree's copy of <paramref name="document"/> moved to the name
    /// <paramref name="newEditorId"/> computes and rewritten there, then the narrow signal for
    /// it.</summary>
    internal static void Rename(
        this IndexProjector index, LoadOrderEntry entry, RecordDocument document, string newEditorId, string body)
    {
        var repository = RepositoryOf(entry);
        repository.Rename(
            entry.KeyOf(), new RecordIdentity(document.FormKey, document.RecordType, document.EditorId), newEditorId);
        repository.Put(
            entry.KeyOf(), new SourceDocument(document.FormKey, document.RecordType, newEditorId, body));
        index.RefreshKeys(entry.KeyOf(), [document.FormKey]);
    }

    /// <summary>A document the working tree gains, then the narrow signal for it.</summary>
    internal static void Create(this IndexProjector index, LoadOrderEntry entry, string formKey, string recordType, string? editorId, string body)
    {
        RepositoryOf(entry).Put(entry.KeyOf(), new SourceDocument(formKey, recordType, editorId, body));
        index.RefreshKeys(entry.KeyOf(), [formKey]);
    }

    /// <summary>Several working-tree changes made the Source repository's own way, then the one
    /// narrow signal a settled Source batch sends for them (ADR-0015 invariant 2). A null body is
    /// the document taken out.</summary>
    internal static void Project(
        this IndexProjector index, LoadOrderEntry entry, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        var repository = RepositoryOf(entry);
        var reads = index.RequireReads();
        foreach (var (formKey, body) in deltas)
        {
            var current = reads.DocumentOf(formKey, entry.KeyOf());
            if (body is null)
                repository.Remove(entry.KeyOf(), new RecordIdentity(formKey, current.RecordType, current.EditorId));
            else
                repository.Put(entry.KeyOf(), new SourceDocument(formKey, current.RecordType, current.EditorId, body));
        }
        index.RefreshKeys(entry.KeyOf(), [.. deltas.Select(d => d.FormKey)]);
    }

    /// <summary>The working tree's copy of <paramref name="document"/> taken out, then the narrow
    /// signal for it.</summary>
    internal static void Delete(this IndexProjector index, LoadOrderEntry entry, RecordDocument document)
    {
        var removed = RepositoryOf(entry).Remove(
            entry.KeyOf(), new RecordIdentity(document.FormKey, document.RecordType, document.EditorId));
        if (removed != SourceRemoval.Removed)
            throw new InvalidOperationException($"The tree did not give up '{document.FormKey}': {removed}.");
        index.RefreshKeys(entry.KeyOf(), [document.FormKey]);
    }

    internal static string BodyOf(this RecordDocument document) =>
        document.Body ?? throw new InvalidOperationException($"Expected document '{document.FormKey}' to carry a body.");

    internal static RecordDocument DocumentOf(this IRecordReads reads, string formKey, PluginCopyKey plugin) =>
        reads.GetDocument(formKey, plugin)
            ?? throw new InvalidOperationException($"Expected a document for '{formKey}' in {plugin.Name} ({plugin.Origin}).");
}
