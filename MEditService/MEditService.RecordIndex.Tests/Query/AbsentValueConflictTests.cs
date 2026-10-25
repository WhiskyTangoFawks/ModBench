using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class AbsentValueConflictTests
{
    private static void Named(MiscItem item) => item.Name = "Master name";
    private static void Renamed(MiscItem item) => item.Name = "Other name";
    private static void Unnamed(MiscItem item) => item.Name = null;

    private static FieldDiff NameOf(params Action<MiscItem>[] copies) =>
        ComparedCopies.Of(copies).Diffs.Single(d => d.FieldName == "Name");

    [Fact]
    public void AnOverrideThatDropsTheMastersValue_IsAnOverride_AndSoIsItsRow()
    {
        var name = NameOf(Named, Unnamed);

        Assert.Equal(ConflictThis.Override, name.CellStates["B.esp"]);
        Assert.Equal(ConflictAll.Override, name.ConflictAll);
    }

    [Fact]
    public void AnOverrideThatDropsTheMastersValue_BeneathALaterOverrideThatChangesIt_ConflictsAndLoses()
    {
        var name = NameOf(Named, Unnamed, Renamed);

        Assert.Equal(ConflictThis.ConflictLoses, name.CellStates["B.esp"]);
        Assert.Equal(ConflictThis.ConflictWins, name.CellStates["C.esp"]);
        Assert.Equal(ConflictAll.Conflict, name.ConflictAll);
    }

    [Fact]
    public void AnOverrideThatLeavesAbsentWhatTheMasterLacks_IsIdenticalToMaster()
    {
        var name = NameOf(Unnamed, Unnamed, Renamed);

        Assert.Equal(ConflictThis.IdenticalToMaster, name.CellStates["B.esp"]);
    }
}
