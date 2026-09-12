using MEditService.Commands.Edits;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>Compile enters the same door as the record gestures (ADR-0003): an unanswered
/// question refuses it with the same kind and message, so upstream's bytes are never overwritten
/// before it is answered.</summary>
public sealed class CompilePluginHandlerDeferralTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private string PluginPath => Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);

    private CompileResult Compile() => _mod.CompileHandler.Compile(_mod.Plugin, new CompileSource.WorkingTree());

    // A change both answers can land: the same records the fixture tracked, one value moved.
    private void RaiseParseableExternalChange()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(SourceEditFixture.PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew(SourceEditFixture.RaceEditorId);
        mod.Keywords.AddNew(SourceEditFixture.KeywordEditorId);
        var npc = mod.Npcs.AddNew(SourceEditFixture.NpcEditorId);
        npc.Race.SetTo(race);
        npc.HeightMax = 0.9f;
        mod.Npcs.AddNew(SourceEditFixture.OtherNpcEditorId);
        mod.WriteToBinary(PluginPath);
        ExternalChangeDeferral.Set(_mod.ModFolder, "unanswered");
    }

    [Fact]
    public void Compile_Refuses_WhileAnExternalChangeQuestionIsUnanswered_LeavingTheBinaryUntouched()
    {
        _mod.RaiseExternalChange();
        var upstreamBytes = File.ReadAllBytes(PluginPath);

        var result = Compile();

        Assert.False(result.Succeeded);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Equal(ExternalChangeDeferral.Unanswered(_mod.ModFolder), result.RefusalReason);
        Assert.Equal(upstreamBytes, File.ReadAllBytes(PluginPath));
    }

    [Fact]
    public void Compile_Succeeds_RightAfterAbsorbAnswersTheQuestion()
    {
        RaiseParseableExternalChange();
        var absorbed = _mod.AbsorbHandler.Absorb(_mod.ModFolder, _mod.PluginCopies(PluginPath), _mod.LoadOrder);
        Assert.True(absorbed.Applied, absorbed.RefusalReason);

        var result = Compile();

        Assert.True(result.Succeeded, result.RefusalReason);
    }

    [Fact]
    public void Compile_Succeeds_RightAfterKeepAnswersTheQuestion()
    {
        RaiseParseableExternalChange();
        var kept = _mod.KeepHandler.Keep(_mod.ModFolder, _mod.PluginCopies(PluginPath), GameRelease.Fallout4);
        Assert.True(kept.Applied, kept.RefusalReason);

        var result = Compile();

        Assert.True(result.Succeeded, result.RefusalReason);
    }
}
