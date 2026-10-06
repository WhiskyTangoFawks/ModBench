namespace MEditService.TestSupport;

/// <summary>How Modbench saves the changes mEdit answers for an edit, as the tests play it: each move in
/// order, then each document's text at its absolute path.</summary>
public static class EditSaving
{
    public static void Save(IEnumerable<(string From, string To)> moves, IEnumerable<(string Path, string Text)> documents)
    {
        foreach (var (from, to) in moves)
        {
            if (Directory.Exists(from)) Directory.Move(from, to);
            else File.Move(from, to);
        }
        foreach (var (path, text) in documents)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
            File.WriteAllText(path, text);
        }
    }
}
