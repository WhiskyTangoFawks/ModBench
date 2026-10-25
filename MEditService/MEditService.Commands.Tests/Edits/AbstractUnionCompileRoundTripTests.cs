using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;

namespace MEditService.Commands.Tests.Edits;

public sealed class AbstractUnionCompileRoundTripTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public async Task AUnionSetToAnotherLeaf_CompilesToABinaryHoldingThatLeaf_WithWhatTheValueGives()
    {
        var quest = _fixture.Seed(new Quest(KeyOf(0x801), Fallout4Release.Fallout4) { EditorID = "Quest", Aliases = [new QuestLocationAlias { Name = "OriginalLoc" }] }, "qust");
        var edited = _fixture.EditHandler.Set(
            _fixture.Plugin, quest, "Aliases",
            JsonDocument.Parse("""[{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "ClosestToAlias": 4, "Location": {"AliasID": 9}}]""").RootElement);
        Assert.True(edited.Applied, edited.Message);

        using var compiled = await _fixture.CompiledAsync(_fixture.Plugin);

        var alias = Assert.IsAssignableFrom<IQuestReferenceAliasGetter>(Assert.Single(compiled.Quests.Single().Aliases.Require()));
        Assert.Equal<(string?, int?, int?)>(("NewRef", 4, 9), (alias.Name, alias.ClosestToAlias, alias.Location?.AliasID));
    }
}
