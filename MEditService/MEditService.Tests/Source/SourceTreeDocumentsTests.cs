using MEditService.Codec.Serialization;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>The reader hands the index the documents the tree already holds. A child embedded in
/// its owner's document has no file of its own, so its text is cut back out of the owner's.</summary>
public sealed class SourceTreeDocumentsTests : IDisposable
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void EveryRecordTheFixtureEmbedsInAnother_ReadsBackAsItsOwnDocument()
    {
        var documents = Documents();

        Assert.Equal(
            EveryEmbeddedChild(),
            [.. EveryEmbeddedChild().Where(child => documents.ContainsKey(child.FormKey))]);
    }

    [Fact]
    public void AChildInAListSlot_IsDeIndentedOutOfItsOwnerAndCarriesNoTypeDiscriminator()
    {
        var text = Documents()[_fixture.TemporaryRef.ToString()].Text;

        Assert.Equal(
            $$"""
            {
              "FormKey": "{{_fixture.TemporaryRef}}",
              "EditorID": "{{ContainerModFixture.TemporaryRefEditorId}}",
              "Scale": 1.0,
              "Position": "11, 22, 33"
            }
            """,
            text);
    }

    [Fact]
    public void AChildInsideAnEmbeddedChild_IsDeIndentedOnceForEachLevelItSitsUnder()
    {
        var documents = Documents();

        Assert.Equal(
            $$"""
            {
              "FormKey": "{{_fixture.TopCell}}",
              "EditorID": "{{ContainerModFixture.TopCellEditorId}}",
              "WaterHeight": 5.0,
              "Temporary": [
                {
                  "MutagenObjectType": "PlacedObject",
                  "FormKey": "{{_fixture.TopCellRef}}",
                  "EditorID": "{{ContainerModFixture.TopCellRefEditorId}}",
                  "Scale": 6.0,
                  "Position": "7, 8, 9"
                }
              ]
            }
            """,
            documents[_fixture.TopCell.ToString()].Text);
        Assert.Equal(
            $$"""
            {
              "FormKey": "{{_fixture.TopCellRef}}",
              "EditorID": "{{ContainerModFixture.TopCellRefEditorId}}",
              "Scale": 6.0,
              "Position": "7, 8, 9"
            }
            """,
            documents[_fixture.TopCellRef.ToString()].Text);
    }

    [Fact]
    public void AChildInASingleValueSlot_IsTheSameBytesTheRepositorysGetAnswers()
    {
        var landscape = _fixture.Landscape.ToString();

        Assert.Equal(_fixture.Document(landscape)!.Body, Documents()[landscape].Text);
    }

    [Fact]
    public void AMemberNoRecordTypeDeclares_SurvivesAHandEditIntoAnEmbeddedChild()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.TemporaryRefEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(
                $"\"EditorID\": \"{ContainerModFixture.TemporaryRefEditorId}\"",
                $"\"EditorID\": \"{ContainerModFixture.TemporaryRefEditorId}\",\n      \"NoSuchMember\": 5",
                StringComparison.Ordinal));

        Assert.Contains(
            "\"NoSuchMember\": 5",
            Documents()[_fixture.TemporaryRef.ToString()].Text,
            StringComparison.Ordinal);
    }

    private List<(string EditorId, string FormKey)> EveryEmbeddedChild() =>
    [
        (ContainerModFixture.TemporaryRefEditorId, _fixture.TemporaryRef.ToString()),
        (ContainerModFixture.PersistentRefEditorId, _fixture.PersistentRef.ToString()),
        (ContainerModFixture.NavmeshEditorId, _fixture.Navmesh.ToString()),
        (ContainerModFixture.LandscapeEditorId, _fixture.Landscape.ToString()),
        (ContainerModFixture.TopCellEditorId, _fixture.TopCell.ToString()),
        (ContainerModFixture.TopCellRefEditorId, _fixture.TopCellRef.ToString()),
        (ContainerModFixture.DialogTopicEditorId, _fixture.DialogTopic.ToString()),
        (ContainerModFixture.DialogTopic2EditorId, _fixture.DialogTopic2.ToString()),
        (ContainerModFixture.DialogTopic3EditorId, _fixture.DialogTopic3.ToString()),
        (ContainerModFixture.ResponseEditorId, _fixture.Response.ToString()),
        (ContainerModFixture.Response2EditorId, _fixture.Response2.ToString()),
        (ContainerModFixture.DialogBranchEditorId, _fixture.DialogBranch.ToString()),
        (ContainerModFixture.SceneEditorId, _fixture.Scene.ToString()),
    ];

    private Dictionary<string, PluginDocument> Documents()
    {
        using var tree = new SourceTreeDocuments(
            _fixture.ModFolder, ContainerModFixture.PluginName, Release,
            SharedSchemaReflector.Instance.GetSchemas(Release));
        return tree.Records.ToDictionary(document => document.FormKey, document => document, StringComparer.Ordinal);
    }
}
