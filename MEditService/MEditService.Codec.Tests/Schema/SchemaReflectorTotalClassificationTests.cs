using MEditService.Codec.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class SchemaReflectorTotalClassificationTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4, "SchemaReflector: unclassified")]
    [InlineData(GameRelease.SkyrimSE, "SchemaReflector: unclassified")]
    [InlineData(GameRelease.Starfield, "SchemaReflector: unclassified")]
    [InlineData(GameRelease.Fallout4, "SchemaReflector: declared defaults unavailable")]
    [InlineData(GameRelease.Fallout4, "SchemaReflector: a colour's alpha unavailable")]
    public void TheWalk_ClassifiesEveryPropertyItReaches_AndMutagenAnswersEveryDefaultAndAlphaItAsks(GameRelease release, string refusal)
    {
        var entries = LoggedWalk.Of(release);

        Assert.NotEmpty(entries);
        Assert.DoesNotContain(entries, e => e.Message.StartsWith(refusal, StringComparison.Ordinal));
    }

    [Fact]
    public void GenderedPairs_AreExcludedByName_InEveryPlaceTheWalkMeetsThem()
    {
        var gendered = LoggedWalk.Of(GameRelease.Fallout4)
            .Where(e => e.Message.Contains("IGenderedItemGetter", StringComparison.Ordinal))
            .Select(e => e.Message)
            .Distinct()
            .ToList();

        Assert.Equal(20, gendered.Count);
        Assert.All(gendered, m => Assert.Contains("excluded", m, StringComparison.Ordinal));
    }
}
