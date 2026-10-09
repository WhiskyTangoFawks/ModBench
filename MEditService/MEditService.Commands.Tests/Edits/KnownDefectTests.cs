using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class KnownDefectTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string OneSceneWithAnAction()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("DocEdit.esp"), Fallout4Release.Fallout4);
        var quest = mod.Quests.AddNew("DefectQuest");
        var scene = new Scene(mod) { EditorID = "DefectScene" };
        scene.Actions.Add(new SceneAction { Name = "First" });
        quest.Scenes.Add(scene);
        _fixture.Seed(quest, "qust");
        return scene.FormKey.ToString();
    }

    [Fact]
    public void APathReachingTheGovernedMember_IsRefusedByName()
    {
        var formKey = OneSceneWithAnAction();
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, SetAt(Json("{}"), Member("Actions"), At(0), Member("Type")));

        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("'Type' is read-only", result.Message, StringComparison.Ordinal);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Fact]
    public void AWholeElementSpellingTheGovernedMember_IsRefusedByName()
    {
        var formKey = OneSceneWithAnAction();

        var (result, _) = _fixture.Apply(
            formKey, SetAt(Json("""{"Name": "Second", "Type": {}}"""), Member("Actions"), At(0)));

        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("'Type' is read-only", result.Message, StringComparison.Ordinal);
    }
}
