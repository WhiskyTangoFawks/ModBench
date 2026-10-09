using MEditService.Codec.Serialization;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The adapter with the tree write's deserialize replaced, which is how the round-trip
/// gate's negative tests forge a codec defect no real codec has.</summary>
internal sealed class ForgedTreeWriteAdapter(Func<string, CancellationToken, Task<IMod>> deserialize)
    : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    public override async Task<Answer<string, PluginFailure>> WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath,
        IReadOnlyList<string> masterOrder, CancellationToken cancel = default)
    {
        using var scratchDir = new ScratchDirectory("medit-forged-writetree-");
        foreach (var file in files)
        {
            var fullPath = Path.Combine(scratchDir, file.RelativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath) ?? throw new InvalidOperationException($"Expected '{fullPath}' to have a parent directory."));
            await File.WriteAllBytesAsync(fullPath, file.Content, cancel);
        }

        var recompiled = await deserialize(scratchDir, cancel);

        await recompiled.BeginWrite
            .ToPath(destinationPath)
            .WithLoadOrder(masterOrder.Select(name => ModKey.FromFileName(name)))
            .WithNoDataFolder()
            .WriteAsync();
        return PluginAnswer.Of(destinationPath);
    }
}
