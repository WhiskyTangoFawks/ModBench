using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Commands.Tests.Edits;

public sealed class NoLoadOrderRefusalTests
{
    private static readonly PluginAddress Plugin = new("Fixture.esp", "FixtureMod");
    private static readonly RecordAt Record = new(Plugin, $"000800:{Plugin.Name}");

    private static T Handler<T>() where T : notnull =>
        TestEditService.Over(new LoadOrderHolder()).GetRequiredService<T>();

    [Fact]
    public async Task Track_WithNoLoadOrderHeld_RefusesTheSelection()
    {
        var answer = await Handler<TrackHandler>().TrackAsync(["FixtureMod"]);

        Assert.Equal(TrackRefusal.NoLoadOrder, answer.SelectionRefusal?.Refusal);
        Assert.Equal(NoLoadOrderException.DefaultMessage, answer.SelectionRefusal?.Message);
    }

    [Fact]
    public async Task Decompile_WithNoLoadOrderHeld_RefusesTheSelection()
    {
        var answer = await Handler<DecompilePluginHandler>().DecompileAsync([Plugin]);

        Assert.Equal(DecompileRefusal.NoLoadOrder, answer.SelectionRefusal?.Refusal);
    }

    [Fact]
    public async Task Compile_WithNoLoadOrderHeld_RefusesTheSelection()
    {
        var answer = await Handler<CompilePluginHandler>().CompileAsync([Plugin]);

        Assert.Equal(CompileRefusal.NoLoadOrder, answer.SelectionRefusal?.Refusal);
    }

    [Fact]
    public async Task CreatePlugin_WithNoLoadOrderHeld_RefusesBeforeWritingAnything()
    {
        using var scratch = new ScratchDirectory("medit-no-load-order-");

        var result = await Handler<CreatePluginHandler>().CreatePlugin(Plugin, scratch.Path);

        Assert.Equal(PluginCreateRefusal.NoLoadOrder, result.Refusal);
        Assert.Empty(Directory.EnumerateFileSystemEntries(scratch.Path));
    }

    [Fact]
    public async Task Copy_WithNoLoadOrderHeld_RefusesTheSelection()
    {
        var answer = await Handler<CopyRecordChangesHandler>().CopyRecords([Record], CopyMode.Override, [Plugin], replace: false);

        Assert.Equal(RecordEditRefusal.NoLoadOrder, answer.SelectionRefusal?.Refusal);
    }

    [Fact]
    public async Task Delete_WithNoLoadOrderHeld_RefusesTheSelection()
    {
        var answer = await Handler<DeleteRecordChangesHandler>().DeleteRecords([Record]);

        Assert.Equal(RecordEditRefusal.NoLoadOrder, answer.SelectionRefusal?.Refusal);
    }

    [Fact]
    public void RenameSource_WithNoLoadOrderHeld_RefusesIt()
    {
        var refusal = Handler<RenameSourceChangesHandler>().RenameSource(Plugin, "Renamed.esp")
            .Match((_, _) => RenameSourceRefusal.NotAPluginFile, (why, _) => why);

        Assert.Equal(RenameSourceRefusal.NoLoadOrder, refusal);
    }

    [Fact]
    public void MoveLastWritten_WithNoLoadOrderHeld_RefusesIt()
    {
        var result = Handler<MoveLastWrittenHandler>().MoveLastWritten(Plugin, Plugin.Name, "Renamed.esp");

        Assert.Equal(RenameSourceRefusal.NoLoadOrder, result.Refusal);
    }
}
