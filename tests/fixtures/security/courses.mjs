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

// A TA does not own a course; access is granted by an explicit assignment.
export const TA_ASSIGNMENTS = [
  { userId: "ta-001@example.invalid", courseId: "course-101@example.invalid" }
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
    // Real ownership: a teacher owns courses by `owner`; a TA is scoped by an
    // explicit assignment. Never infer access from a shared e-mail domain.
    const scopedCourseIds = new Set(
      COURSES.filter((course) => course.owner === userId).map((course) => course.courseId)
    );
    for (const assignment of TA_ASSIGNMENTS) {
      if (assignment.userId === userId) scopedCourseIds.add(assignment.courseId);
    }
    return data.filter(
      (item) => item.owner === userId || (typeof item.courseId === "string" && scopedCourseIds.has(item.courseId))
    );
  }
  if (userRole === "student") {
    return data.filter((item) => item.studentId === userId || item.owner === userId);
  }
  return [];
}
