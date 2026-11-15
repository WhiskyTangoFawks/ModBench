using System.Collections.Concurrent;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>Named files of a plugin's tree read alone (ADR-0001), against what the tree's last listing found at their paths.</summary>
internal static class NamedFiles
{
    // Git takes each path as an argument, and a command line holds a few hundred.
    private const int MostPaths = 100;

    private static readonly StringComparer PathComparer = StringComparer.FromComparison(FilePaths.Comparison);

    internal static FilesRead? Read(
        string sourceFolder, PluginAddress plugin, ISourceFiles disk, SourceTreeDocuments documents,
        ConcurrentDictionary<string, string?>? listed, IReadOnlyList<string> named,
        Func<IReadOnlyList<string>, IReadOnlyDictionary<string, RecordChange>> changedSinceLastCommit)
    {
        if (listed is null || named.Count > MostPaths) return null;
        var root = SourceRepositoryLayout.RootIn(sourceFolder, plugin.Name);
        var paths = named.Select(Path.GetFullPath).ToList();
        if (!paths.All(path => Under(root, path))) return null;

        var files = new HashSet<string>(PathComparer);
        foreach (var path in paths)
        {
            if (disk.DirectoryExists(path)) files.UnionWith(disk.FilesIn(path, $"*{SourceRepositoryLayout.JsonSuffix}", SearchOption.AllDirectories));
            else if (path.EndsWith(SourceRepositoryLayout.JsonSuffix, StringComparison.OrdinalIgnoreCase)) files.Add(path);
            files.UnionWith(listed.Keys.Where(file => Under(path, file)));
        }

        var held = new HashSet<string>(StringComparer.Ordinal);
        var now = new Dictionary<string, IReadOnlyList<PluginDocument>>(PathComparer);
        // A group's document carries no record: where a cell sits is its folders' names.
        foreach (var file in files.Where(file => !SourceRepositoryLayout.IsGroupDocument(file)))
        {
            if (!documents.ReadsAsARecord(file)) return null;
            if (listed.TryGetValue(file, out var formKey))
            {
                if (formKey is null) return null;
                held.Add(formKey);
            }
            now[file] = documents.DocumentsIn(file);
        }

        var own = now.Values.Where(records => records.Count > 0).Select(records => records[0]).ToList();
        var holds = now.Values.SelectMany(records => records).Select(record => record.FormKey).ToHashSet(StringComparer.Ordinal);
        if (own.DistinctBy(document => document.FormKey).Count() < own.Count
            || listed.Any(entry => !files.Contains(entry.Key) && entry.Value is { } other && (holds.Contains(other) || held.Contains(other))))
        {
            return null;
        }

        foreach (var (file, records) in now)
        {
            if (records.Count > 0) listed[file] = records[0].FormKey;
            else listed.TryRemove(file, out _);
        }
        var changes = changedSinceLastCommit([.. paths.Select(path => Path.GetRelativePath(sourceFolder, path))]);
        return new FilesRead(own, [.. held.Except(holds)], changes);
    }

    private static bool Under(string folder, string path) =>
        path.Equals(folder, FilePaths.Comparison) || path.StartsWith(folder + Path.DirectorySeparatorChar, FilePaths.Comparison);
}
