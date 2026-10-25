using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;

namespace MEditService.Commands.Tests.Edits;

public sealed class AbstractUnionCompileRoundTripTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public async Task AUnionSetToAnotherLeaf_CompilesToABinaryThatReadsBackAsTheDocument()
    {
        var quest = _fixture.Seed(new Quest(KeyOf(0x801), Fallout4Release.Fallout4) { EditorID = "Quest", Aliases = [new QuestLocationAlias { Name = "OriginalLoc" }] }, "qust");
        var edited = _fixture.EditHandler.Set(
            _fixture.Plugin, quest, "Aliases",
            JsonDocument.Parse("""[{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "ClosestToAlias": 4, "Location": {"AliasID": 9}}]""").RootElement);
        Assert.True(edited.Applied, edited.Message);

        using var compiled = await _fixture.CompiledAsync(_fixture.Plugin);

        Assert.Equal(
            AliasesOf(_fixture.Document(quest)),
            AliasesOf(RecordTextCodec.SerializeToText(compiled.Quests.Single(), GameRelease.Fallout4)));
    }

    private static string AliasesOf(string document) => JsonNode.Parse(document).Require()["Aliases"].Require().ToJsonString();
}
