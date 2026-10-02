using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class KeyedArrayAddTests : IDisposable
{
    private static readonly ModKey Mod = ModKey.FromFileName("DocEdit.esp");

    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private string SeedFactionWithRankZero() => _fixture.Seed(
        new Faction(new FormKey(Mod, 0x800), Fallout4Release.Fallout4) { Ranks = [new Rank { Number = 0 }, new Rank { Number = 1 }] },
        "fact");

    private string SeedQuestWithStageZero() => _fixture.Seed(
        new Quest(new FormKey(Mod, 0x801), Fallout4Release.Fallout4) { Stages = [new QuestStage { Index = 0 }, new QuestStage { Index = 10 }] },
        "qust");

    private RecordEditResult Add(string formKey, string array) => _fixture.Apply(formKey, AddAt(Member(array))).Result;

    private void AssertSecondAddIsRefused(string formKey, string array)
    {
        Assert.True(Add(formKey, array).Applied);
        var before = _fixture.Document(formKey);

        var second = Add(formKey, array);

        Assert.False(second.Applied);
        Assert.Equal(RecordEditRefusal.DuplicateKeyInKeyedArray, second.Refusal);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Fact]
    public void AFactionHoldingRankZero_TakesANewRank()
    {
        var result = Add(SeedFactionWithRankZero(), "Ranks");

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void AFactionHoldingRankZero_RefusesASecondNewRank_UntilTheFirstIsNumbered() =>
        AssertSecondAddIsRefused(SeedFactionWithRankZero(), "Ranks");

    [Fact]
    public void AQuestHoldingStageZero_TakesANewStage()
    {
        var result = Add(SeedQuestWithStageZero(), "Stages");

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void AQuestHoldingStageZero_RefusesASecondNewStage_UntilTheFirstIsIndexed() =>
        AssertSecondAddIsRefused(SeedQuestWithStageZero(), "Stages");
}
