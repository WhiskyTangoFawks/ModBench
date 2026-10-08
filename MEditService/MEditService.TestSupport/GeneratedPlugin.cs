namespace MEditService.TestSupport;

public record GeneratedPlugin(string FileName, byte[] Bytes)
{
    public void WriteInto(string directory) => File.WriteAllBytes(Path.Combine(directory, FileName), Bytes);
}
