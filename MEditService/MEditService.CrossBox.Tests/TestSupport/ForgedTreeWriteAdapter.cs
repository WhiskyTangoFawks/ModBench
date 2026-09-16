using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.Tests.TestSupport;

/// <summary>The adapter with the tree write's deserialize replaced, which is how the round-trip
/// gate's negative tests forge a codec defect no real codec has.</summary>
internal sealed class ForgedTreeWriteAdapter(TreeDeserializer deserialize) : ReadOnlyPluginAdapter
{
    public override async Task WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, CancellationToken cancel = default)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-forged-writetree-").FullName;
        try
        {
            foreach (var file in files)
            {
                var fullPath = Path.Combine(scratchDir, file.RelativePath);
                Directory.CreateDirectory(PathShape.DirectoryOf(fullPath));
                await File.WriteAllBytesAsync(fullPath, file.Content, cancel);
            }

            var treeRoot = Path.Combine(scratchDir, SharedRootOf(files));
            var recompiled = await deserialize(treeRoot, cancel);

            await recompiled.BeginWrite
                .ToPath(destinationPath)
                .WithLoadOrderFromHeaderMasters()
                .WithNoDataFolder()
                .NoNextFormIDProcessing()
                .WithRecordCount(RecordCountOption.NoCheck)
                .WriteAsync();
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }

    // Mirrors PluginTrees' own materialization: every file of one plugin's tree sits under that
    // tree's root, so their common directory is it.
    private static string SharedRootOf(IReadOnlyList<TreeFile> files)
    {
        var shared = Path.GetDirectoryName(files.Count > 0 ? files[0].RelativePath : "") ?? "";
        foreach (var file in files)
        {
            var directory = Path.GetDirectoryName(file.RelativePath) ?? "";
            while (shared.Length > 0
                   && !directory.Equals(shared, StringComparison.Ordinal)
                   && !directory.StartsWith(shared + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                shared = Path.GetDirectoryName(shared) ?? "";
            }
        }
        return shared;
    }
}
