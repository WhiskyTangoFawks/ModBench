using MEditService.Codec.Serialization;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>One plugin's tree as files, and what compile asks of them as files. A tree made from records holds no
/// file on disk, so it names the record a file holds.</summary>
public sealed class PluginTreeFiles
{
    private readonly string _pluginFileName;
    private readonly PluginSourceFiles _held;
    private readonly GameRelease _release;
    private readonly Func<RecordIdentity, string?>? _located;

    internal PluginTreeFiles(string pluginFileName, PluginSourceFiles held, GameRelease release, Func<RecordIdentity, string?>? located)
    {
        (_pluginFileName, _held, _release, _located) = (pluginFileName, held, release, located);
        Files = SourceRepositoryLayout.DoorTreeOf(pluginFileName, held.Files, release);
    }

    /// <summary>The tree of <paramref name="files"/>, the whole-mod door's. A container's directory holding several
    /// documents, none named RecordData.json, is ambiguous.</summary>
    public static Answer<PluginTreeFiles, SourceFailure> Made(string pluginFileName, IReadOnlyList<TreeFile> files, GameRelease release) =>
        SourceFailure.Answer(() => new PluginTreeFiles(
            pluginFileName, new PluginSourceFiles(SourceRepositoryLayout.PristineFilesOf(pluginFileName, files), null), release, located: null));

    /// <summary>The tree as the whole-mod door reads it, empty when a file is unreadable.</summary>
    public IReadOnlyList<TreeFile> Files { get; }

    /// <summary>The file the read stopped at, relative to the source folder.</summary>
    public string? Unreadable => _held.Unreadable;

    /// <summary>Every file the Codec refuses, with its reason.</summary>
    public Answer<IReadOnlyList<RefusedFile>, SourceFailure> RefusedFiles() =>
        SourceFailure.Answer(() => PluginSourceChecks.RefusedFilesOf(_pluginFileName, _held, _release));

    /// <summary>Which of <paramref name="formKeys"/> more than one document claims. Asked of the files, not of the
    /// compiled mod: Mutagen's FormKey-keyed RecordCache collapses two documents in one group folder to the last read.</summary>
    public Answer<IReadOnlyList<string>, SourceFailure> CollidingFormKeys(IEnumerable<FormKey> formKeys) =>
        SourceFailure.Answer(() => PluginSourceChecks.CollidingFormKeys(_pluginFileName, _held, formKeys, _release));

    /// <summary>Where the tree and <paramref name="serialized"/>, the whole-mod door's tree, first part ways, and the
    /// files held at another leaf name than the layout's. An unreadable file outranks the rest.</summary>
    public Answer<SourceComparison, SourceFailure> Compare(IReadOnlyList<TreeFile> serialized) =>
        SourceFailure.Answer(() => PluginSourceChecks.Compare(_pluginFileName, _held, serialized, _release));

    /// <summary><paramref name="diagnosis"/> of a read of <see cref="Files"/>, each file it names named as a refusal
    /// names it.</summary>
    public Answer<PluginDiagnosis, SourceFailure> Named(PluginDiagnosis diagnosis) =>
        SourceFailure.Answer(() => SourceRepositoryLayout.InSourceNames(_pluginFileName, diagnosis, _held.Files, _release, Named));

    /// <summary>The file at <paramref name="path"/>, relative to the source folder, as a refusal names it.</summary>
    public string Named(string path)
    {
        if (_located is not null) return path;
        var held = _held.Files.FirstOrDefault(file => file.RelativePath == path);
        return held is null ? path : PluginSourceChecks.FormKeyOf(path, held.Content, _pluginFileName) ?? path;
    }

    /// <summary>The record <paramref name="identity"/> names, as a refusal names it.</summary>
    public Answer<string, SourceFailure> Named(RecordIdentity identity) =>
        FileOf(identity).Holds(out var file, out var unread) ? SourceAnswer.Of(file ?? identity.FormKey) : unread;

    /// <summary>The file on disk that holds <paramref name="identity"/>, relative to the source folder; null for a tree
    /// made from records.</summary>
    public Answer<string?, SourceFailure> FileOf(RecordIdentity identity) =>
        SourceFailure.Answer(() => _located is null
            ? null
            : _located(identity)
                ?? throw new InvalidOperationException($"Expected the tree to hold {identity.FormKey}'s document."));
}
