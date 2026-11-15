using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>Named files of a plugin's tree read alone (ADR-0001), against what the tree's last listing found at their paths.</summary>
internal static class NamedFiles
{
    // Git takes each path as an argument, and a command line holds a few hundred.
    internal const int MostPaths = 100;

    internal static FilesRead? Read(
        string sourceFolder, PluginAddress plugin, ISourceFiles disk, SourceTreeDocuments documents, TreeListing? listing,
        IReadOnlyList<string> named, WrittenDocuments written)
    {
        if (listing is null || named.Count > MostPaths) return null;
        var root = SourceRepositoryLayout.RootIn(sourceFolder, plugin.Name);
        var paths = named.Select(Path.GetFullPath).ToList();
        if (!paths.All(path => Under(root, path))) return null;

        var files = new HashSet<string>(TreeListing.PathComparer);
        foreach (var path in paths)
        {
            var listed = listing.Files.Select(file => file.Key).Where(file => Under(path, file)).ToList();
            if (disk.DirectoryExists(path)) files.UnionWith(disk.FilesIn(path, $"*{SourceRepositoryLayout.JsonSuffix}", SearchOption.AllDirectories));
            else if (disk.FileExists(path) || listing.KnowsGone(path)) files.Add(path);
            else if (listed.Count == 0) return null;
            files.UnionWith(listed);
        }

        var standing = new Dictionary<string, (string Text, string Stamp)>(TreeListing.PathComparer);
        foreach (var file in files)
        {
            if (written.At(file) is { } document) standing[file] = document;
        }
        files.RemoveWhere(file => !standing.ContainsKey(file) && listing.HoldsWhatWasWritten(file));
        var held = new HashSet<string>(StringComparer.Ordinal);
        var now = new Dictionary<string, IReadOnlyList<PluginDocument>>(TreeListing.PathComparer);
        foreach (var file in files)
        {
            if (!file.EndsWith(SourceRepositoryLayout.JsonSuffix, StringComparison.OrdinalIgnoreCase) || !documents.ReadsAsARecord(file)) return null;
            if (listing.Holds(file, out var formKey))
            {
                if (formKey is null) return null;
                held.Add(formKey);
            }
            now[file] = documents.DocumentsIn(file, standing.TryGetValue(file, out var document) ? document.Text : null);
        }

        var own = now.Values.Where(records => records.Count > 0).Select(records => records[0]).ToList();
        var holds = now.Values.SelectMany(records => records).Select(record => record.FormKey).ToHashSet(StringComparer.Ordinal);
        if (own.DistinctBy(document => document.FormKey).Count() < own.Count
            || listing.Files.Any(entry => !files.Contains(entry.Key) && entry.Value is { } other && (holds.Contains(other) || held.Contains(other))))
        {
            return null;
        }

        foreach (var (file, records) in now)
        {
            if (records.Count > 0) listing.Read(file, records[0].FormKey, standing.TryGetValue(file, out var document) ? document.Stamp : null);
            else listing.ReadGone(file);
        }
        return new FilesRead(own, [.. held.Except(holds)]);
    }

    internal static bool Under(string folder, string path) =>
        path.Equals(folder, FilePaths.Comparison) || path.StartsWith(folder + Path.DirectorySeparatorChar, FilePaths.Comparison);
}
