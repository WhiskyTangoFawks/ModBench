using System.Text.Json;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Query;

public sealed class RecordHeaderCompareTests
{
    private const int PartialFormBit = 0x0000_4000;

    private static Dictionary<string, FieldDiff> PartialFormOverride() =>
        ComparedCopies.Of<Worldspace>(
                world => world.LodWaterHeight = 100f,
                world =>
                {
                    world.MajorRecordFlagsRaw |= PartialFormBit;
                    world.LodWaterHeight = 999f;
                })
            .Diffs.ToDictionary(d => d.FieldName, StringComparer.Ordinal);

    [Fact]
    public void APartialFormCopysHeaderMembers_TakePart_WhereItsOwnFieldsDoNot()
    {
        var diffs = PartialFormOverride();

        var flags = diffs["MajorRecordFlagsRaw"];
        Assert.Equal(PartialFormBit, Assert.IsType<JsonElement>(flags.Values["B.esp"]).GetInt32());
        Assert.Equal(ConflictThis.Override, flags.CellStates["B.esp"]);
        Assert.Null(diffs["LodWaterHeight"].Values["B.esp"]);
    }

    [Fact]
    public void AHeaderMemberNoCopySpells_StillHasItsRow()
    {
        var version2 = PartialFormOverride()["Version2"];

        Assert.Equal(2, version2.Values.Count);
        Assert.All(version2.Values.Values, Assert.Null);
    }
}
