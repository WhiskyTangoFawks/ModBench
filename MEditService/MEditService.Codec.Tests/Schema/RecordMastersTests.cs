using MEditService.Codec.Schema;

namespace MEditService.Codec.Tests.Schema;

public class RecordMastersTests
{
    [Theory]
    [InlineData("000800:Fallout4.esm", new string[0], new[] { "Fallout4.esm" })]
    [InlineData("000800:Host.esp", new[] { "000801:DLCRobot.esm", "000802:Fallout4.esm" }, new[] { "DLCRobot.esm", "Fallout4.esm" })]
    [InlineData("000800:HOST.ESP", new[] { "000801:host.esp" }, new string[0])]
    [InlineData("000800:Host.esp", new[] { "000801:Fallout4.esm", "000802:FALLOUT4.ESM" }, new[] { "Fallout4.esm" })]
    [InlineData("000800:Host.esp", new[] { "None", "Null", "000000:Null" }, new string[0])]
    [InlineData("000800:Host.esp", new[] { "", "garbage", "000801:Fallout4", "000801:Fallout4.txt" }, new string[0])]
    public void TheMastersARecordRequires_AreThePluginsItsFormKeyAndLinksName_OtherThanItsOwn(
        string formKey, string[] links, string[] masters)
    {
        Assert.Equal(masters, RecordMasters.Of("Host.esp", formKey, links));
    }
}
