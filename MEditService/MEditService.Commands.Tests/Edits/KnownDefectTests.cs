using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A member a KnownDefects row governs: the schema names it and says why it is read-only,
/// and every path reaching it is refused by name rather than written.</summary>
public sealed class KnownDefectTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static readonly RecordTableSchema Scenes =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["scen"];

    private static SubFieldSpec SceneActionType() =>
        Scenes.RecordColumns.Single(c => c.Name == "Actions").Field.ElementSpec.Require().SubFields.Require()
            .Single(f => f.Name == "Type");

    // A Scene has no file of its own; it exists only embedded in a Quest's document.
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
    public void TheGovernedMember_IsNamedInTheSchema_ReadOnlyWithItsReason()
    {
        var type = SceneActionType();

        Assert.Equal("ASceneActionType", type.LeafTypeName);
        Assert.Empty(type.SubFields.Require());
        Assert.Contains("unimplemented throw upstream", type.ReadOnlyReason, StringComparison.Ordinal);
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
