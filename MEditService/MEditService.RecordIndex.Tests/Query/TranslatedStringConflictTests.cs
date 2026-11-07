using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class TranslatedStringConflictTests
{
    [Theory]
    [InlineData(Language.English)]
    [InlineData(Language.French)]
    public void ACopyNotLocalized_HoldingTheMastersTextsInTheStringsLanguage_IsIdenticalToMaster_InTheConflictView(Language stringsLanguage)
    {
        using var copies = new LocalizedCopies(stringsLanguage);

        var compare = copies.Index.Queries.GetCompare(LocalizedCopies.Message.ToString()).Value().Require();

        Assert.Equal(ConflictThis.IdenticalToMaster, compare.Overrides.Single(o => o.Plugin == LocalizedCopies.Copy.Name).ConflictThis);
    }

    [Theory]
    [InlineData(Language.English)]
    [InlineData(Language.French)]
    public void ACopyNotLocalized_HoldingTheMastersTextsInTheStringsLanguage_ComparesWithItsMasterWithNoConflict(Language stringsLanguage)
    {
        using var copies = new LocalizedCopies(stringsLanguage);
        var message = LocalizedCopies.Message.ToString();

        var compared = copies.Index.Queries.GetCompareRecords(
            [new RecordCopy(message, LocalizedCopies.Master), new RecordCopy(message, LocalizedCopies.Copy)]).Compared();

        Assert.Equal(ConflictAll.NoConflict, compared.ConflictAll);
    }
}
