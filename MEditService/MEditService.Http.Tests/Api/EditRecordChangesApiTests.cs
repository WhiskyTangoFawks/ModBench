using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class EditRecordChangesApiTests : HostedTests
{
    private const string Plugin = "Editable.esp";
    private const string Origin = "EditableMod";

    private async Task<string> Loaded(bool compiledPlugin)
    {
        var fx = Owned(new PluginFixtureBuilder("api-edit-changes")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("EditableNpc"), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        if (compiledPlugin)
        {
            (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
            await Client.NextCheck(fx);
            await Client.PluginReportsCompiledPlugin(Plugin);
        }
        return await Client.FirstFormKey(Plugin, Origin);
    }

    [Theory]
    [InlineData(true, "no_such_field", 1, HttpStatusCode.NotFound, "FieldNotFound")]
    [InlineData(false, "HeightMax", 0.75, HttpStatusCode.Conflict, "PluginNotCompiledPlugin")]
    [InlineData(true, "FormKey", "not a FormKey", HttpStatusCode.UnprocessableEntity, "CodecRejected")]
    public async Task ARefusedEdit_AnswersItsArmsStatus_WithItsOwnRefusal(
        bool compiledPlugin, string member, object value, HttpStatusCode status, string refusal)
    {
        var formKey = await Loaded(compiledPlugin);

        var response = await Client.EditChanges(formKey, Plugin, Origin, member, value);

        Assert.Equal(refusal, (await response.AssertIsProblem(status)).GetProperty("refusal").GetString());
    }
}
