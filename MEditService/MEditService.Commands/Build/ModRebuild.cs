using MEditService.ModFolderAdapter;
using Octodiff.Core;
using Octodiff.Diagnostics;

namespace MEditService.Commands.Build;

/// <summary>What a mod lacks to come back as its manifest says, and the writes that bring it back. Every delta is
/// applied before any file is written.</summary>
internal sealed class ModRebuild(IModFolderRepository repository, ModToDiscard mod, InstanceToDiscard instance, Manifest manifest) : IDisposable
{
    internal sealed record Lack(string Text, bool DeltaMissing = false);

    private interface ISource;

    private sealed record EntrySource(InstallationFile File, string Path) : ISource;

    private sealed record GameSource(OverriddenGameFile File) : ISource;

    private sealed record DeltaSource(ISource Basis, string BaseHash, (InstallationFile File, string Entry)? PackedIn) : ISource;

    private readonly Dictionary<string, ISource> _sources = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Stream> _applied = new(StringComparer.Ordinal);
    private readonly List<Stream> _scratch = [];

    /// <summary>Finds where each file comes from, and names each source it lacks once.</summary>
    public IReadOnlyList<Lack> Resolve(IReadOnlyList<ManifestFile> files)
    {
        List<Lack> lacks = [];
        foreach (var file in files)
        {
            var (source, lacking) = SourceOf(file);
            if (source is not null) _sources[file.Path] = source;
            lacks.AddRange(lacking);
        }
        return [.. lacks.Distinct()];
    }

    /// <summary>Applies each delta into a scratch file. The first whose result is not the file its name says is the
    /// lack.</summary>
    public Lack? ApplyDeltas(IReadOnlyList<ManifestFile> files)
    {
        List<(ManifestFile File, DeltaSource Delta, EntrySource Entry)> onEntries = [];
        foreach (var file in files)
        {
            switch (_sources[file.Path])
            {
                case DeltaSource { Basis: GameSource game } delta:
                    using (var basis = repository.OpenGameFile(instance.DataFolder, game.File.Path))
                    {
                        if (Apply(file, delta, basis) is { } lack) return lack;
                    }
                    break;
                case DeltaSource { Basis: EntrySource entry } delta:
                    onEntries.Add((file, delta, entry));
                    break;
            }
        }
        foreach (var fromOne in onEntries.GroupBy(d => d.Entry.File))
        {
            Lack? lack = null;
            var wanted = fromOne.ToLookup(d => d.Entry.Path, StringComparer.OrdinalIgnoreCase);
            Extract(fromOne.Key, wanted.Select(group => group.Key), (entry, content) =>
            {
                var basis = Scratch();
                content.CopyTo(basis);
                foreach (var (file, delta, _) in wanted[entry]) lack ??= Apply(file, delta, basis);
            });
            if (lack is not null) return lack;
        }
        return null;
    }

    /// <summary>Writes each file from its source. A write that fails leaves the files before it written.</summary>
    public void Write(IReadOnlyList<ManifestFile> files)
    {
        List<(string Path, EntrySource Entry)> fromEntries = [];
        foreach (var path in files.Select(file => file.Path))
        {
            switch (_sources[path])
            {
                case GameSource game:
                    repository.WriteFile(mod.Folder, path, target =>
                    {
                        using var copy = repository.OpenGameFile(instance.DataFolder, game.File.Path);
                        copy.CopyTo(target);
                    });
                    break;
                case DeltaSource:
                    repository.WriteFile(mod.Folder, path, target =>
                    {
                        var applied = _applied[path];
                        applied.Position = 0;
                        applied.CopyTo(target);
                    });
                    break;
                case EntrySource entry:
                    fromEntries.Add((path, entry));
                    break;
            }
        }
        foreach (var fromOne in fromEntries.GroupBy(file => file.Entry.File))
        {
            var wanted = fromOne.ToLookup(file => file.Entry.Path, file => file.Path, StringComparer.OrdinalIgnoreCase);
            Extract(fromOne.Key, wanted.Select(group => group.Key), (entry, content) =>
            {
                var first = wanted[entry].First();
                repository.WriteFile(mod.Folder, first, content.CopyTo);
                foreach (var path in wanted[entry].Skip(1))
                {
                    repository.WriteFile(mod.Folder, path, target =>
                    {
                        using var copy = repository.OpenFile(mod.Folder, first);
                        copy.CopyTo(target);
                    });
                }
            });
        }
    }

    public void Dispose()
    {
        foreach (var stream in _scratch) stream.Dispose();
    }

    private (ISource? Source, IEnumerable<Lack> Lacks) SourceOf(ManifestFile file) => file.Provider switch
    {
        FileProvider.NoProvider => (null, [new($"'{file.Path}' has no provider")]),
        FileProvider.FirstInstallationFile => manifest.InstallationFiles is [var first, ..]
            ? EntryOf(first.Name, file.Path, file.Hash)
            : (null, [new($"'{file.Path}' names no installation file")]),
        FileProvider.InstallationFileEntry entry => EntryOf(entry.InstallationFile, entry.Path, file.Hash),
        FileProvider.InstallationFileDelta delta => DeltaOf(EntryOf(delta.InstallationFile, delta.Path, delta.BaseHash), file, delta.BaseHash),
        FileProvider.GameFile game => GameFileOf(game.Path, file.Hash),
        FileProvider.GameFileDelta delta => DeltaOf(GameFileOf(delta.Path, delta.BaseHash), file, delta.BaseHash),
        _ => throw new ArgumentOutOfRangeException(nameof(file), file.Provider, null),
    };

    private (ISource?, IEnumerable<Lack>) EntryOf(string name, string entryPath, string hash)
    {
        var handed = mod.InstallationFiles.FirstOrDefault(file => repository.InstallationFileName(file.Path) == name);
        if (handed is null || !repository.InstallationFileExists(handed.Path))
            return (null, [new($"installation file '{name}' is not in the downloads folder")]);
        if (manifest.InstallationFiles.FirstOrDefault(source => source.Name == name)?.Hash != handed.Hash)
            return (null, [new($"installation file '{name}' has other bytes")]);
        return handed.Entries.Any(entry => string.Equals(entry.Path, entryPath, StringComparison.OrdinalIgnoreCase) && entry.Hash == hash)
            ? (new EntrySource(handed, entryPath), [])
            : (null, [new($"installation file '{name}' holds no '{entryPath}' with the bytes its manifest names")]);
    }

    private (ISource?, IEnumerable<Lack>) GameFileOf(string path, string hash)
    {
        var handed = instance.GameFiles.FirstOrDefault(game => string.Equals(game.Path, path, StringComparison.OrdinalIgnoreCase));
        if (handed is null) return (null, [new($"game file '{path}' is missing")]);
        var named = manifest.GameFiles.FirstOrDefault(source => string.Equals(source.Name, path, StringComparison.OrdinalIgnoreCase));
        return named?.Hash == handed.Hash && handed.Hash == hash ? (new GameSource(handed), []) : (null, [new($"game file '{path}' has other bytes")]);
    }

    private (ISource?, IEnumerable<Lack>) DeltaOf((ISource? Source, IEnumerable<Lack> Lacks) basis, ManifestFile file, string baseHash)
    {
        var name = repository.DeltaName(file.Path, baseHash, file.Hash);
        using var loose = repository.OpenDelta(instance.BuildFolder, instance.DownloadsFolder, file.Path, baseHash, file.Hash);
        var packedIn = loose is null ? PackedIn(name) : null;
        if (loose is null && packedIn is null) return (null, [.. basis.Lacks, new($"delta '{name}' is missing", DeltaMissing: true)]);
        return basis.Source is null ? (null, basis.Lacks) : (new DeltaSource(basis.Source, baseHash, packedIn), []);
    }

    private (InstallationFile File, string Entry)? PackedIn(string deltaName) =>
        mod.InstallationFiles.Concat(instance.DownloadedFiles)
            .SelectMany(downloaded => downloaded.Entries.Select(entry => (File: downloaded, Entry: entry.Path)))
            .Where(packed => string.Equals(packed.Entry[(packed.Entry.LastIndexOf('/') + 1)..], deltaName, StringComparison.OrdinalIgnoreCase))
            .Select(packed => ((InstallationFile, string)?)packed)
            .FirstOrDefault();

    private Lack? Apply(ManifestFile file, DeltaSource source, Stream basis)
    {
        using var delta = Opened(file, source);
        var applied = Scratch();
        basis.Position = 0;
        var otherBytes = new Lack($"delta '{repository.DeltaName(file.Path, source.BaseHash, file.Hash)}' has other bytes");
        try
        {
            new DeltaApplier().Apply(basis, new BinaryDeltaReader(delta, new NullProgressReporter()), applied);
        }
        catch (CorruptFileFormatException)
        {
            return otherBytes;
        }
        applied.Position = 0;
        if (repository.Hash(applied) != file.Hash) return otherBytes;
        _applied[file.Path] = applied;
        return null;
    }

    private Stream Opened(ManifestFile file, DeltaSource source)
    {
        if (source.PackedIn is not { } packed)
        {
            return repository.OpenDelta(instance.BuildFolder, instance.DownloadsFolder, file.Path, source.BaseHash, file.Hash)
                ?? throw new FileNotFoundException($"delta '{repository.DeltaName(file.Path, source.BaseHash, file.Hash)}' is gone");
        }
        var delta = Scratch();
        Extract(packed.File, [packed.Entry], (_, content) => content.CopyTo(delta));
        delta.Position = 0;
        return delta;
    }

    private void Extract(InstallationFile file, IEnumerable<string> entries, Action<string, Stream> onEntry)
    {
        var wanted = entries.ToHashSet(StringComparer.OrdinalIgnoreCase);
        using var archive = repository.OpenInstallationFile(file.Path);
        try
        {
            ArchiveExtractor.Extract(archive, (entry, content) =>
            {
                if (wanted.TryGetValue(entry, out var asNamed)) onEntry(asNamed, content);
            });
        }
        catch (SharpCompress.Common.SharpCompressException e)
        {
            throw new IOException($"'{repository.InstallationFileName(file.Path)}' is not an archive discard can read: {e.Message}", e);
        }
    }

    private Stream Scratch()
    {
        var scratch = repository.CreateScratchFile(instance.BuildFolder);
        _scratch.Add(scratch);
        return scratch;
    }
}
