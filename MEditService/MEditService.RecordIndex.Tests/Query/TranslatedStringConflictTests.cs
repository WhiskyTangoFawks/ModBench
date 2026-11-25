using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class TranslatedStringConflictTests
{
    [Fact]
    public void ACopyNotLocalized_HoldingTheMastersTextsInTheStringsLanguage_IsIdenticalToMaster_InTheConflictView()
    {
        using var copies = new LocalizedCopies();

        var compare = copies.Index.Queries.GetCompare(LocalizedCopies.Message.ToString()).Value().Require();

        Assert.Equal(ConflictThis.IdenticalToMaster, compare.Overrides.Single(o => o.Plugin == LocalizedCopies.Copy.Name).ConflictThis);
    }

    [Fact]
    public void ACopyNotLocalized_HoldingTheMastersTextsInTheStringsLanguage_ComparesWithItsMasterWithNoConflict()
    {
        using var copies = new LocalizedCopies();
        var message = LocalizedCopies.Message.ToString();

        var compared = copies.Index.Queries.GetCompareRecords(
            [new RecordCopy(message, LocalizedCopies.Master), new RecordCopy(message, LocalizedCopies.Copy)]).Compared();

        Assert.Equal(ConflictAll.NoConflict, compared.ConflictAll);
    }
}
