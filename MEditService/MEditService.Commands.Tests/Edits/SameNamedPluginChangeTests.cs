using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class SameNamedPluginChangeTests : IDisposable
{
    private readonly SameNamedTargetFixture _fx = new();

    public void Dispose() => _fx.Dispose();

    [Fact]
    public void EditingTheFormId_OfTheCopyModOrderResolvesTo_CarriesAnotherPlugin_AndLeavesTheOtherCopyOfItsFileNameAsItWas()
    {
        var losingBefore = SourceModTree.Records(_fx.ModFolderOf(_fx.Losing), _fx.Losing);

        var result = _fx.EditHandler.SetFormId(_fx.Winning, _fx.Race.ToString(), "000F00:Base.esm");

        Assert.True(result.Applied, result.Message);
        Assert.Contains("000F00:Base.esm", _fx.DocumentCarrying(_fx.Referencer, SameNamedTargetFixture.ReferencerNpcEditorId).Body, StringComparison.Ordinal);
        Assert.Equal(losingBefore, SourceModTree.Records(_fx.ModFolderOf(_fx.Losing), _fx.Losing));
    }

    [Fact]
    public void EditingTheFormId_OfACopyModOrderDoesNotResolveTo_CarriesOnlyItsOwnSource()
    {
        var winningBefore = SourceModTree.Records(_fx.ModFolderOf(_fx.Winning), _fx.Winning);
        var referencerBefore = SourceModTree.Records(_fx.ModFolderOf(_fx.Referencer), _fx.Referencer);

        var result = _fx.EditHandler.SetFormId(_fx.Losing, _fx.Race.ToString(), "000F00:Base.esm");

        Assert.True(result.Applied, result.Message);
        Assert.Contains("000F00:Base.esm", _fx.DocumentCarrying(_fx.Losing, SameNamedTargetFixture.BaseNpcEditorId).Body, StringComparison.Ordinal);
        Assert.Equal(winningBefore, SourceModTree.Records(_fx.ModFolderOf(_fx.Winning), _fx.Winning));
        Assert.Equal(referencerBefore, SourceModTree.Records(_fx.ModFolderOf(_fx.Referencer), _fx.Referencer));
    }

    [Fact]
    public void RenamingTheSource_OfTheCopyModOrderResolvesTo_LeavesTheOtherCopyOfItsFileNameAsItWas()
    {
        var losingRoot = PluginSourceRoot.In(_fx.ModFolderOf(_fx.Losing), _fx.Losing.Name);

        var changes = _fx.RenameSourceHandler.RenameSource(_fx.Winning, "New.esm", namedByFileName: true, sourceFiles: [])
            .Match(landed => landed, (refusal, message) => throw new InvalidOperationException($"{refusal}: {message}"));

        Assert.Contains(changes.Documents, document => document.Path.StartsWith(PluginSourceRoot.In(_fx.ModFolderOf(_fx.Referencer), _fx.Referencer.Name), StringComparison.Ordinal));
        Assert.DoesNotContain(changes.Documents, document => document.Path.StartsWith(losingRoot, StringComparison.Ordinal));
    }
}
