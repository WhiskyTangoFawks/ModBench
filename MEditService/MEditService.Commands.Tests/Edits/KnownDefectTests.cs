using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class KnownDefectTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private string OneSceneWithAnAction()
    {
        var mod = new Fallout4Mod(DocumentEditFixture.ModKey, Fallout4Release.Fallout4);
        var quest = mod.Quests.AddNew("DefectQuest");
        var scene = new Scene(mod) { EditorID = "DefectScene" };
        scene.Actions.Add(new SceneAction { Name = "First" });
        _fixture.Seed(quest, "qust");
        return _fixture.SeedChild(quest, "qust", "Scenes", scene, "scen");
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
