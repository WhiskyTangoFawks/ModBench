using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class KeyedArrayAddTests : IDisposable
{
    private static readonly ModKey Mod = ModKey.FromFileName("DocEdit.esp");

    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private string SeedQuestWithStageZero() => _fixture.Seed(
        new Quest(new FormKey(Mod, 0x801), Fallout4Release.Fallout4) { Stages = [new QuestStage { Index = 0 }, new QuestStage { Index = 10 }] },
        "qust");

    private RecordEditResult Add(string formKey, string array) => _fixture.Apply(formKey, AddAt(Member(array))).Result;

    [Fact]
    public void AQuestHoldingStageZero_TakesTwoNewStages_EachAtStageZero()
    {
        var formKey = SeedQuestWithStageZero();

        Assert.True(Add(formKey, "Stages").Applied);
        var second = Add(formKey, "Stages");

        Assert.True(second.Applied, second.Message);
        Assert.Equal(
            [0, 10, 0, 0],
            JsonNode.Parse(_fixture.Document(formKey)).Require()["Stages"].Require().AsArray()
                .Select(stage => stage.Require()["Index"]?.GetValue<int>() ?? 0));
    }
}
