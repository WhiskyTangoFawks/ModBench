using MEditService.Index.Queries;

namespace MEditService.Index.Tests.Query;

public class ConflictRulesTests
{
    [Fact]
    public void Worst_IsTheMostSevereContribution_NoMatterTheOrder()
    {
        ConflictAll[] contributions = [ConflictAll.Conflict, ConflictAll.ConflictBenign, ConflictAll.Override];

        Assert.Equal(ConflictAll.ConflictBenign, ConflictRules.Worst(ConflictAll.NoConflict, contributions));
        Assert.Equal(ConflictAll.ConflictBenign, ConflictRules.Worst(ConflictAll.NoConflict, contributions.Reverse()));
    }

    [Fact]
    public void Worst_OfNoContributions_IsTheSeed()
    {
        Assert.Equal(ConflictAll.Override, ConflictRules.Worst(ConflictAll.Override, []));
    }
}
