using MEditService.Codec.Schema;

namespace MEditService.Codec.Tests.Schema;

public class FormKeyComparerTests
{
    [Theory]
    [InlineData("000800:Master.esm", "000800_master.ESM", true)]
    [InlineData("00080a:Master.esm", "00080A:Master.esm", true)]
    [InlineData("000800:Master.esm", "000801:Master.esm", false)]
    [InlineData("garbage", "garbage", true)]
    [InlineData("garbage", "000800:Master.esm", false)]
    public void TwoSpellings_AreOneFormKey_WhenMutagenReadsThemAsOne(string left, string right, bool same)
    {
        Assert.Equal(same, FormKeyComparer.Instance.Equals(left, right));
        if (same) Assert.Equal(FormKeyComparer.Instance.GetHashCode(left), FormKeyComparer.Instance.GetHashCode(right));
    }
}
