using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>The files a source mod's manifest takes from the installation files it names, extracted to scratch files
/// the build reads as assets (modlist-repository.md, The manifest, story 7).</summary>
internal sealed class TakenFromInstallationFiles(IModFolderRepository repository, string modFolder) : IDisposable
{
    private readonly IScratchFiles _scratch = repository.CreateScratchFiles();
    private readonly List<(ManifestFile Line, PackageEntry.FromInstallationFile From, InstallationFile File)> _taken = [];

    /// <summary>Null when every installation file the manifest names is handed with the bytes it pins and holds each entry a
    /// line takes; otherwise the build's refusal, naming the files the request has not handed.</summary>
    public ItemAnswer<BuildStop, ModBuildOutcome>? Lacking(Manifest manifest, IReadOnlyList<InstallationFile> handed)
    {
        var checking = new HandedInstallationFiles(repository, handed);
        Dictionary<string, InstallationFile> files = [];
        List<PackageContents.Lack> lacks = [];
        foreach (var named in manifest.InstallationFiles)
        {
            var (file, lack) = checking.Of(named);
            if (file is not null) files[named.Name] = file;
            if (lack is not null) lacks.Add(lack);
        }
        foreach (var line in manifest.Files)
        {
            if (line.Entry is not PackageEntry.FromInstallationFile from || !files.TryGetValue(from.Name, out var file)) continue;
            var inside = from.PathIn(line.Path);
            if (!file.Entries.Any(entry => string.Equals(entry.Path, inside, StringComparison.OrdinalIgnoreCase)))
                lacks.Add(new PackageContents.Lack($"installation file '{from.Name}' holds no '{inside}'"));
            else _taken.Add((line, from, file));
        }
        if (lacks.Count == 0) return null;
        return ItemAnswer<BuildStop, ModBuildOutcome>.Refused(
            new BuildStop(BuildRefusal.InstallationFileLacking)
            {
                InstallationFilesNotFound = [.. lacks.OfType<PackageContents.Lack.InstallationFileMissing>().Select(lack => lack.Named)],
            },
            $"was not built: {string.Join("; ", lacks.Select(lack => lack.Text))}.");
    }

    /// <summary>Each taken file as an asset, read from a temporary file this removes once the build is done.</summary>
    public IEnumerable<Asset> Extract()
    {
        List<Asset> extracted = [];
        var rebuild = new ModRebuild(repository, modFolder);
        foreach (var fromOne in _taken.GroupBy(taken => taken.File))
        {
            var wanted = fromOne.ToLookup(taken => taken.From.PathIn(taken.Line.Path), taken => taken.Line.Path, StringComparer.OrdinalIgnoreCase);
            rebuild.Extract(fromOne.Key, wanted.Select(group => group.Key), (entry, content) =>
            {
                var stored = _scratch.Store(content);
                foreach (var path in wanted[entry]) extracted.Add(new Asset(path, stored));
            });
        }
        return extracted;
    }

    public void Dispose() => _scratch.Dispose();
}
