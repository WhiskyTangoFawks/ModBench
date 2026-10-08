using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Query;

public sealed class VersionStampConflictTests
{
    private static void Stamped(Keyword keyword)
    {
        keyword.Notes = "Unchanged";
        keyword.VersionControl = 1;
        keyword.FormVersion = 120;
        keyword.Version2 = 1;
    }

    private static void WithDifferingStamps(Keyword keyword)
    {
        keyword.Notes = "Unchanged";
        keyword.VersionControl = 2;
        keyword.FormVersion = 121;
        keyword.Version2 = 3;
    }

    [Theory]
    [InlineData("VersionControl")]
    [InlineData("FormVersion")]
    [InlineData("Version2")]
    public void GetCompare_DifferingVersionStamp_ShowsNoConflict(string stamp)
    {
        var diff = ComparedCopies.Of<Keyword>(Stamped, WithDifferingStamps).Diffs.Single(d => d.FieldName == stamp);

        Assert.Equal(ConflictAll.NoConflict, diff.ConflictAll);
        Assert.Empty(diff.CellStates);
        Assert.Equal(2, diff.Values.Count(v => v.Value != null));
    }

    [Fact]
    public void GetCompare_CopiesDifferingInTheVersionStampsAlone_ShowNoConflictOnTheRecordOrThePlugin()
    {
        var compare = ComparedCopies.Of<Keyword>(Stamped, WithDifferingStamps);

        Assert.Equal(ConflictAll.NoConflict, compare.ConflictAll);
        Assert.Equal(ConflictThis.IdenticalToMaster, compare.Overrides.Single(o => o.Plugin == "B.esp").ConflictThis);
    }

    [Fact]
    public void GetCompare_CopiesDifferingInTheVersionStampsAndAnotherField_ConflictOnThatFieldAlone()
    {
        var compare = ComparedCopies.Of<Keyword>(Stamped, keyword =>
        {
            WithDifferingStamps(keyword);
            keyword.Notes = "Changed";
        });

        Assert.Equal(ConflictAll.Override, compare.ConflictAll);
        Assert.Equal(ConflictThis.Override, compare.Overrides.Single(o => o.Plugin == "B.esp").ConflictThis);
    }
}
