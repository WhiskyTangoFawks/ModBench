using MEditService.Commands.Build;
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

    public static TheoryData<string, Func<Task<object?>>> Gestures => new()
    {
        { "Decompile", async () => (await Handler<DecompilePluginHandler>().DecompileAsync([Plugin])).SelectionRefusal?.Refusal },
        { "Compile", async () => (await Handler<CompilePluginHandler>().CompileAsync([Plugin])).SelectionRefusal?.Refusal },
        { "Copy", async () => (await Handler<CopyRecordChangesHandler>().CopyRecords([Record], CopyMode.Override, [Plugin], replace: false)).SelectionRefusal?.Refusal },
        { "Delete", async () => (await Handler<DeleteRecordChangesHandler>().DeleteRecords([Record])).SelectionRefusal?.Refusal },
        {
            "RenameSource",
            () => Task.FromResult<object?>(Handler<RenameSourceChangesHandler>().RenameSource(Plugin, "Renamed.esp")
                .Match((_, _) => RenameSourceRefusal.NotAPluginFile, (why, _) => why))
        },
        { "MoveLastWritten", () => Task.FromResult<object?>(Handler<MoveLastWrittenHandler>().MoveLastWritten(Plugin, Plugin.Name, "Renamed.esp").Refusal) },
    };

    [Theory]
    [MemberData(nameof(Gestures))]
    public async Task AGestureWithNoLoadOrderHeld_IsRefusedAsNoLoadOrder(string gesture, Func<Task<object?>> attempt)
    {
        var refusal = (await attempt())?.ToString();

        Assert.True(refusal == "NoLoadOrder", $"{gesture} answered {refusal ?? "no refusal"}");
    }

    [Fact]
    public async Task Track_WithNoLoadOrderHeld_RefusesTheSelection()
    {
        var answer = await Handler<InitHandler>().InitAsync(ToInit.Named("FixtureMod"));

        Assert.Equal(InitRefusal.NoLoadOrder, answer.SelectionRefusal?.Refusal);
        Assert.Equal(NoLoadOrderException.DefaultMessage, answer.SelectionRefusal?.Message);
    }

    [Fact]
    public async Task CreatePlugin_WithNoLoadOrderHeld_RefusesBeforeWritingAnything()
    {
        using var scratch = new ScratchDirectory("medit-no-load-order-");

        var result = await Handler<CreatePluginHandler>().CreatePlugin(Plugin, scratch.Path, scratch.Path);

        Assert.Equal(PluginCreateRefusal.NoLoadOrder, result.Refusal);
        Assert.Empty(Directory.EnumerateFileSystemEntries(scratch.Path));
    }
}
