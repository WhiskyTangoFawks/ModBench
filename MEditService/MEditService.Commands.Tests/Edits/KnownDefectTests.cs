using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.Edits;

/// <summary>A member a KnownDefects row governs: the schema names it and says why it is read-only,
/// and every path reaching it is refused by name rather than written.</summary>
public sealed class KnownDefectTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static readonly RecordTableSchema Scenes =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["scen"];

    private static SubFieldSpec SceneActionType() =>
        Scenes.RecordColumns.Single(c => c.Name == "Actions").Field.ElementSpec!.SubFields!
            .Single(f => f.Name == "Type");

    private static string OneSceneWithAnAction()
    {
        var scene = new Scene(FormKey.Factory("000800:KnownDefect.esp"), Fallout4Release.Fallout4)
        {
            EditorID = "DefectScene",
        };
        scene.Actions.Add(new SceneAction { Name = "First" });
        return DocumentEdits.Serialize(scene);
    }

    [Fact]
    public void TheGovernedMember_IsNamedInTheSchema_ReadOnlyWithItsReason()
    {
        var type = SceneActionType();

        Assert.Equal("ASceneActionType", type.LeafTypeName);
        Assert.Empty(type.SubFields!);
        Assert.Contains("unimplemented throw upstream", type.ReadOnlyReason, StringComparison.Ordinal);
    }

    [Fact]
    public void APathReachingTheGovernedMember_IsRefusedByName()
    {
        var before = OneSceneWithAnAction();

        var refused = DocumentEdits.Apply(
            before, Scenes, SetAt(Json("{}"), Member("Actions"), At(0), Member("Type")), out var written);

        Assert.Equal(RecordEditRefusal.FieldReadOnly, refused?.Refusal);
        Assert.Contains("'Type' is read-only", refused!.Message, StringComparison.Ordinal);
        Assert.Equal(before, written);
    }

    [Fact]
    public void AWholeElementSpellingTheGovernedMember_IsRefusedByName()
    {
        var refused = DocumentEdits.Apply(
            OneSceneWithAnAction(), Scenes,
            SetAt(Json("""{"Name": "Second", "Type": {}}"""), Member("Actions"), At(0)), out _);

        Assert.Equal(RecordEditRefusal.FieldReadOnly, refused?.Refusal);
        Assert.Contains("'Type' is read-only", refused!.Message, StringComparison.Ordinal);
    }
}
