// Security test fixtures - synthetic multi-course/class/student isolation data.
// All domains use @example.invalid. No real personal data.

export const COURSES = [
  { courseId: "course-101@example.invalid", title: "Introduction to SmartBook", owner: "teacher-001@example.invalid" },
  { courseId: "course-102@example.invalid", title: "Advanced Data Structures", owner: "teacher-002@example.invalid" },
  { courseId: "course-201@example.invalid", title: "Calculus I", owner: "teacher-003@example.invalid" }
];

export const CLASSES = [
  { classId: "class-a@example.invalid", courseId: "course-101@example.invalid", name: "Section A" },
  { classId: "class-b@example.invalid", courseId: "course-101@example.invalid", name: "Section B" },
  { classId: "class-c@example.invalid", courseId: "course-102@example.invalid", name: "Section C" }
];

export const STUDENTS = [
  { studentId: "student-001@example.invalid", name: "Synthetic Student One", classId: "class-a@example.invalid", courseId: "course-101@example.invalid" },
  { studentId: "student-002@example.invalid", name: "Synthetic Student Two", classId: "class-a@example.invalid", courseId: "course-101@example.invalid" },
  { studentId: "student-003@example.invalid", name: "Synthetic Student Three", classId: "class-b@example.invalid", courseId: "course-101@example.invalid" },
  { studentId: "student-004@example.invalid", name: "Synthetic Student Four", classId: "class-c@example.invalid", courseId: "course-102@example.invalid" }
];

export const ENROLLMENTS = [
  { studentId: "student-001@example.invalid", courseId: "course-101@example.invalid", classId: "class-a@example.invalid" },
  { studentId: "student-002@example.invalid", courseId: "course-101@example.invalid", classId: "class-a@example.invalid" },
  { studentId: "student-003@example.invalid", courseId: "course-101@example.invalid", classId: "class-b@example.invalid" },
  { studentId: "student-004@example.invalid", courseId: "course-102@example.invalid", classId: "class-c@example.invalid" }
];

export function studentsInCourse(courseId) {
  return ENROLLMENTS.filter((e) => e.courseId === courseId).map((e) => STUDENTS.find((s) => s.studentId === e.studentId)).filter(Boolean);
}

export function studentsInClass(classId) {
  return ENROLLMENTS.filter((e) => e.classId === classId).map((e) => STUDENTS.find((s) => s.studentId === e.studentId)).filter(Boolean);
}

export function courseForStudent(studentId) {
  const enrollment = ENROLLMENTS.find((e) => e.studentId === studentId);
  return enrollment ? COURSES.find((c) => c.courseId === enrollment.courseId) : null;
}

export function isolateData(userRole, userId, data) {
  if (userRole === "admin") return data;
  if (userRole === "teacher" || userRole === "ta") {
    return data.filter((item) => item.courseId && item.courseId.endsWith("@example.invalid"));
  }
  if (userRole === "student") {
    return data.filter((item) => item.studentId === userId || item.owner === userId);
  }
  return [];
}
