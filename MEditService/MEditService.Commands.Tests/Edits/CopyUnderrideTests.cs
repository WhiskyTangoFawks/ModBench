using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyUnderrideTests : IDisposable
{
    private readonly LoadOrderOfPlugins _plugins = new();
    private readonly Fallout4Mod _destination = Plugin("Dest.esp", _ => { });
    private readonly Fallout4Mod _referenced = Plugin("Ref.esp", mod => mod.Keywords.AddNew("RefKeyword"));
    private readonly Fallout4Mod _patch;
    private readonly FormKey _npc;

    public CopyUnderrideTests()
    {
        var game = Plugin("Fallout4.esm", mod => mod.Npcs.AddNew("GameNpc"));
        _npc = game.Npcs.First().FormKey;
        _patch = Plugin("Patch.esp", mod => mod.Npcs.Add(new Npc(_npc, Fallout4Release.Fallout4)
        {
            EditorID = "GameNpc",
            Keywords = [new FormLink<IKeywordGetter>(_referenced.Keywords.First().FormKey)],
        }));
        _plugins.Load((game, false), (_destination, true), (_referenced, false), (_patch, false));
    }

    public void Dispose() => _plugins.Dispose();

    private SelectionResult<CopyItem, RecordEditRefusal, string?> CopyThePatchsNpcIntoTheDestination() =>
        _plugins.CopyHandler.CopySync([new RecordAt(Address(_patch), _npc.ToString())], CopyMode.Override, [Address(_destination)], replace: false);

    [Fact]
    public void CopyingAsOverride_IntoAPluginThatLoadsBeforeAPluginHoldingARecordTheCopyReferences_IsRefused_NamingIt()
    {
        var refused = CopyThePatchsNpcIntoTheDestination().OnlyRefused();

        Assert.Equal(RecordEditRefusal.UnderrideDestination, refused.Refusal);
        Assert.Contains("Ref.esp", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ADisabledPluginHoldingARecordTheCopyReferences_IsJudgedAtItsLine()
    {
        _plugins.Relist(Address(_referenced), entry => entry with { Enabled = false });

        Assert.Equal(RecordEditRefusal.UnderrideDestination, CopyThePatchsNpcIntoTheDestination().OnlyRefused().Refusal);
    }

    [Fact]
    public void APluginHoldingARecordTheCopyReferences_WithNoLine_IsNotJudged()
    {
        _plugins.Relist(Address(_referenced), entry => entry with { Line = null });

        CopyThePatchsNpcIntoTheDestination().OnlyLanded();
    }
}
