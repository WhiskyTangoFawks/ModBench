using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
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
        { "Decompile", async () => (await Handler<DecompilePluginHandler>().DecompileAsync([Plugin], force: false)).WholeSelectionRefusal().Refusal },
        { "Compile", async () => (await Handler<CompilePluginHandler>().CompileAsync([Plugin])).WholeSelectionRefusal().Refusal },
        { "Copy", async () => (await Handler<CopyRecordChangesHandler>().CopyRecords([Record], CopyMode.Override, [Plugin], replace: false)).WholeSelectionRefusal().Refusal },
        { "Delete", async () => (await Handler<DeleteRecordChangesHandler>().DeleteRecords([Record])).WholeSelectionRefusal().Refusal },
        {
            "RenameSource",
            () => Task.FromResult<object?>(Handler<RenameSourceChangesHandler>().RenameSource(Plugin, "Renamed.esp", namedByFileName: true, sourceFiles: [])
                .Match(_ => RenameSourceRefusal.NotAPluginFile, (why, _) => why))
        },
        { "MoveLastWritten", () => Task.FromResult<object?>(Handler<MoveLastWrittenHandler>().MoveLastWritten(Plugin, Plugin.Name, "Renamed.esp").Refusal) },
        { "VersionInGit", async () => (await Handler<VersionInGitHandler>().VersionInGitAsync(ToVersionInGit.In(null, Plugin.Origin))).WholeSelectionRefusal().Refusal },
        { "CreatePlugin", async () => (await Handler<CreatePluginHandler>().CreatePlugin(Plugin, "/no/folder", "/no/folder")).Refused().Refusal },
    };

    [Theory]
    [MemberData(nameof(Gestures))]
    public async Task AGestureWithNoLoadOrderHeld_IsRefusedAsNoLoadOrder(string gesture, Func<Task<object?>> attempt)
    {
        var refusal = (await attempt())?.ToString();

        Assert.True(refusal == "NoLoadOrder", $"{gesture} answered {refusal ?? "no refusal"}");
    }
}
