using MEditService.RecordIndex.Tests.TestSupport;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class RecordNameLanguageTests
{
    [Theory]
    [InlineData(Language.English, "Abraxo Cleaner")]
    [InlineData(Language.French, "Nettoyant Abraxo")]
    public void ARecordsListedName_IsItsNameInTheStringsLanguage(Language stringsLanguage, string name)
    {
        using var copies = new LocalizedCopies(stringsLanguage);

        var listed = copies.Index.Queries.GetRecords(["misc"], LocalizedCopies.Master, search: null, limit: 10, offset: 0).Value();

        Assert.Equal(name, listed.Items.Single().FullName);
    }
}
