using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Real source reads, each answering <paramref name="binarySha256"/> as the hash of the bytes
/// it was read from.</summary>
internal sealed class ReadingAs(string binarySha256) : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    public override async Task<Answer<PluginSource, PluginFailure>> ReadSourceOfAsync(
        RegisteredPlugin plugin, GameRelease gameRelease, PluginStrings strings, CancellationToken cancel = default) =>
        (await base.ReadSourceOfAsync(plugin, gameRelease, strings, cancel)).Map(source => source with { BinarySha256 = binarySha256 });
}
