using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public async Task Compile_OfATreeHoldingADocumentTheCodecDoesNotProduce_RefusesNamingIt()
    {
        var stray = TreeTampering.StrayGroupDocument(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, stray), refused.Message, StringComparison.Ordinal);
        Assert.Equal(CompileRefusal.SourceRegenerable, refused.Refusal);
    }
}
