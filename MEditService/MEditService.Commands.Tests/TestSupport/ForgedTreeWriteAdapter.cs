using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The adapter with the tree write's deserialize replaced, which is how the round-trip
/// gate's negative tests forge a codec defect no real codec has.</summary>
internal sealed class ForgedTreeWriteAdapter(string pluginFileName, TreeDeserializer deserialize)
    : ReadOnlyPluginAdapter
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
                Directory.CreateDirectory((Path.GetDirectoryName(fullPath) ?? throw new InvalidOperationException("Expected a parent directory.")));
                await File.WriteAllBytesAsync(fullPath, file.Content, cancel);
            }

            var treeRoot = Path.Combine(scratchDir, SourceRepository.RootFor(pluginFileName));
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
}
